# Pairing a model host

How a Lyrica server (`lyricad`) and a model host come to trust each other,
and how every later connection is checked. Both sides implement exactly this.

## Keys

- Each side has one long-lived key and a self-signed X.509 certificate for
  it. ECDSA P-256 is recommended; Ed25519 and RSA of 2048 bits or more also
  work. The host makes its own at first start, in its data volume, readable
  only by its user. `lyricad` keeps one per server in `self.db`.
- Trust is in the **key**, not the certificate or the address. A side's
  **fingerprint** is the SHA-256 of the DER `SubjectPublicKeyInfo` of the
  certificate it presents, written as 64 lowercase hex characters.
  In Node: `createHash("sha256").update(new X509Certificate(der).publicKey.export({ type: "spki", format: "der" })).digest("hex")`.
- Names, subjects, validity dates and hostnames in certificates are ignored.

## Connections

- The host listens on port **7236** with TLS 1.3 only. It asks every client
  for a certificate and accepts any, so pairing and the dashboard can work;
  each request is then checked as below.
- The client always presents its certificate, including for pairing.
- The client always computes the fingerprint of the certificate the host
  presented before sending anything:
  - when pairing, it uses that fingerprint in the proof;
  - after pairing, if it differs from the pinned one, the client closes the
    connection and reports **"This host's identity changed. Pair it again."**
    It never falls back to the next address with a different key, and never
    re-pins on its own.
- Addresses are only where to look. A client may try several in order; the
  pinned fingerprint is the same for all of them.

## The pairing code

- On the dashboard, **Pair with Lyrica** makes a code and shows it there (never
  in the host's log). It lasts **10 minutes** or until used. Making a new
  code voids the old one. There is at most one code at a time.
- 16 symbols from Crockford's base32 alphabet,
  `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (80 bits), shown in groups of four:
  `7KQ2-M9XD-4RTB-W1HZ`.
- **Normalising** a typed code: upper-case it, remove `-` and whitespace, map
  `O` to `0` and `I` and `L` to `1`. Anything that isn't then 16 symbols of
  the alphabet is refused by the client without contacting the host.
- After **5 wrong proofs** the code is void and a new one must be made.

## The exchange

Notation: `code` is the normalised code as ASCII. `hostFp` and `clientFp`
are fingerprints as lowercase hex. `b64u` is base64url without padding.
`\n` is a single line feed byte.

```
K = HKDF-SHA256(ikm = code, salt = "" (empty), info = "lyrica-pair-v1", length = 32)
```

1. The client opens a TLS connection to the host, presenting its
   certificate, and computes `hostFp` from the certificate the host
   presented.
2. It makes `clientNonce`: 32 random bytes, as `b64u`.
3. It sends:

   ```
   POST /pair/v1
   Content-Type: application/json

   { "name": "Lyrica on lyrica-vm",
     "clientNonce": "<b64u>",
     "proof": b64u(HMAC-SHA256(K, "lyrica-pair-v1/client\n" + hostFp + "\n" + clientFp + "\n" + clientNonce)) }
   ```

   `name` is 1 to 80 characters, shown on the host's dashboard.
4. The host computes the same proof using **its own** fingerprint and the
   fingerprint of the certificate the client presented on this connection,
   and compares in constant time.
   - No code active or expired: `403 { "error": { "code": "no_code" } }`.
   - No client certificate: `400 { "error": { "code": "client_certificate_required" } }`.
   - Wrong proof: `403 { "error": { "code": "pairing_failed" } }`, and one
     of the 5 tries is used up.
   - Right proof: the host pins `clientFp` with `name` and the time, voids
     the code, and answers:

   ```
   200
   { "host": { "name": "lyrica-blackwell", "fingerprint": "<hostFp>" },
     "proof": b64u(HMAC-SHA256(K, "lyrica-pair-v1/host\n" + hostFp + "\n" + clientFp + "\n" + clientNonce)) }
   ```

5. The client recomputes the host proof with its own `hostFp` and `clientFp`
   and compares in constant time. Only if it matches does it pin `hostFp`.
   If not, it pins nothing and reports that pairing failed.

Why this holds:
- Someone without the code can't make either proof. Guessing online is
  capped at 5 tries per code; 80 bits can't be searched offline from an
  overheard proof.
- A machine in the middle terminates TLS on both sides, so the client
  computes with the middle's certificate as `hostFp` and the host sees the
  middle's certificate as `clientFp`. The host's check fails, the host pins
  nothing, and the middle can't forge the host's answer without the code.

Test vector (each line is one value):

```
code        7KQ2M9XD4RTBW1HZ
hostFp      1111111111111111111111111111111111111111111111111111111111111111
clientFp    2222222222222222222222222222222222222222222222222222222222222222
clientNonce AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
K (hex)     8551f07be59ec35fb366df9d9636af19c0eb255f91a8f68e50438a24ffc4c508
client proof acKMiH71_UsFFMT2FChTk49sf1unJSbzakH9g2jZpbY
host proof   an8T3niOqqc4RbFGohVv7KASZd_iq2rLT4l6gaCy_l4
```

`host/test/pairing.test.ts` checks these values.

## After pairing

- Every request except `POST /pair/v1` and the dashboard needs a pinned
  client certificate. An unpaired or revoked certificate gets
  `401 { "error": { "code": "unpaired", "message": "This Lyrica server isn't paired with this host." } }`.
- The host lists paired clients on its dashboard (name, fingerprint, when
  paired, last seen) and can revoke any of them. Revoking takes effect on
  the next request, including on open connections.
- A host can be paired with several Lyrica servers.
- Unpairing from Lyrica's side is forgetting the pin; the host keeps the
  client listed until it is revoked there.
- Pairing again from a client that is already paired replaces its name.
- Only the dashboard can make a code or revoke a client. A paired client
  can't.

## For a Node client

```ts
const agent = new https.Agent({
  key: lyricaKeyPem, cert: lyricaCertPem,
  minVersion: "TLSv1.3",
  rejectUnauthorized: false, // self-signed; checked on "secureConnect" below
});
// On every new socket, before writing a request:
socket.on("secureConnect", () => {
  if (spkiFingerprint(socket.getPeerX509Certificate()) !== pinned) socket.destroy(new HostIdentityChanged());
});
```

Session resumption must be off for pinned connections (`maxCachedSessions:
0` on the agent), so every connection presents and checks a certificate.
