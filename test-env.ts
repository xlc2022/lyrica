// Tests make commits with `git -c user.name=…`. A Lyrica sandbox sets the Git account's identity in GIT_AUTHOR_* and
// GIT_COMMITTER_*, which beat -c, so tests run there (her own checks) start without them.
for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete process.env[k];
