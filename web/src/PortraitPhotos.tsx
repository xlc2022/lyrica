// Principles 1 and 2: reference photos in the user's encrypted home, with their cloud choice.
import { useRef, useState } from "react";
import { del, get, post, put, u, type PhotoCloudSetting, type PortraitPhoto, type UploadResponse } from "./api.ts";
import { RowMenu } from "./Machines.tsx";
import { Section } from "./Panel.tsx";
import { basename } from "./paths.tsx";
import { ConfirmDialog, ErrorText, useAction, useLoad } from "./ui.tsx";

const MAX_BYTES = 20 * 1024 * 1024;
const CLOUD_HINT = "The first time a day one would go to a cloud model, she asks first. A yes lasts until the end of that day.";

export function PortraitPhotosSection({ userId }: { userId: string }) {
  const base = u(userId, "photos-of-me"), cloud = u(userId, "photo-cloud");
  const photos = useLoad(() => get<PortraitPhoto[]>(base), [userId]);
  const setting = useLoad(() => get<PhotoCloudSetting>(cloud), [userId]);
  const [run, busy, error] = useAction();
  const picker = useRef<HTMLInputElement>(null);
  const [removing, setRemoving] = useState<PortraitPhoto>();
  const url = (photo: PortraitPhoto) => u(userId, "photos-of-me", basename(photo.path));
  const upload = (files: File[]) => run(async () => {
    const errors: string[] = [];
    for (const file of files) {
      if (file.size > MAX_BYTES) { errors.push(`${file.name}: Each photo must be at most 20 MB.`); continue; }
      try { await post<UploadResponse>(base, file); }
      catch (e) { errors.push(`${file.name}: ${(e as Error).message}`); }
    }
    photos.set(await get<PortraitPhoto[]>(base));
    if (errors.length) throw new Error(errors.join("\n"));
  });
  return (
    <Section title="Portrait photos">
      <div className="row">
        {photos.data && <span className="pill"><span className="mono">{photos.data.length}</span>&nbsp;photos</span>}
        <button type="button" disabled={busy || !photos.data} onClick={() => picker.current?.click()}>Add photos</button>
        <input ref={picker} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" aria-label="Add photos" onChange={(e) => {
          const files = Array.from(e.target.files ?? []); e.target.value = "";
          if (files.length) void upload(files);
        }} />
      </div>
      <ErrorText error={photos.error || setting.error || error} />
      {photos.data?.length === 0 && <p className="muted">No photos yet.</p>}
      <div className="portrait-grid">
        {photos.data?.map((photo) => {
          const name = basename(photo.path);
          return (
            <div key={photo.path} className="portrait-photo">
              <img src={url(photo)} alt={name} loading="lazy" />
              <div className="portrait-cap">
                <span className="cap mono" title={name}>{name}</span>
                <RowMenu label={`Actions for ${name}`} items={[
                  { label: "Download", onPick: () => { const a = document.createElement("a"); a.href = url(photo); a.download = name; a.click(); } },
                  { label: "Delete…", danger: true, onPick: () => { if (!busy) setRemoving(photo); } },
                ]} />
              </div>
            </div>
          );
        })}
      </div>
      <label className="field">
        <span title={CLOUD_HINT}>Sending them to a cloud image model</span>
        <select title={CLOUD_HINT} disabled={busy || !setting.data} value={setting.data?.policy ?? "ask"}
          onChange={(e) => { const policy = e.target.value as PhotoCloudSetting["policy"]; void run(async () => setting.set(await put<PhotoCloudSetting>(cloud, { policy }))); }}>
          <option value="ask">Ask once a day</option>
          <option value="never">Never</option>
          <option value="always">Always</option>
        </select>
      </label>
      {removing && <ConfirmDialog title={`Delete ${basename(removing.path)}?`} sentence="This photo is deleted from your portrait photos."
        danger confirm="Delete" onCancel={() => setRemoving(undefined)} onConfirm={() => {
          const photo = removing; setRemoving(undefined);
          void run(async () => { await del(url(photo)); photos.set(await get<PortraitPhoto[]>(base)); });
        }} />}
    </Section>
  );
}
