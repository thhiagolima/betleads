// Storage placeholders for the demo tenant (spec §9): voice audio and e-mail
// images are never copied; every reference points to a neutral placeholder
// stored under the demo tenant's own path. A reset deletes and re-uploads them.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PLACEHOLDER_SECONDS } from "./make-placeholders.mjs";

export const VOICE_BUCKET = "call-audios";
export const IMAGE_BUCKET = "email-images";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "placeholders");

export function readPlaceholders() {
  const audio = readFileSync(resolve(DIR, "silence.mp3"));
  const image = readFileSync(resolve(DIR, "neutral.png"));
  return { audio, image, audioSeconds: PLACEHOLDER_SECONDS };
}

/** Where the demo placeholders live. */
export function placeholderLayout(demoTenantId, storageBaseUrl) {
  const base = String(storageBaseUrl ?? "").replace(/\/+$/, "");
  const audioPath = `${demoTenantId}/demo/placeholder.mp3`;
  const imagePath = `${demoTenantId}/placeholder.png`;
  return {
    audioPath,
    imagePath,
    voiceAssetPath: (assetId) => `${demoTenantId}/journeys/${assetId}-placeholder.mp3`,
    audioUrl: `${base}/storage/v1/object/${VOICE_BUCKET}/${audioPath}`,
    imageUrl: `${base}/storage/v1/object/public/${IMAGE_BUCKET}/${imagePath}`,
    // Folders wiped on reset (only the demo tenant's own prefixes).
    prefixes: [
      { bucket: VOICE_BUCKET, folder: `${demoTenantId}/demo` },
      { bucket: VOICE_BUCKET, folder: `${demoTenantId}/journeys` },
      { bucket: IMAGE_BUCKET, folder: `${demoTenantId}` },
    ],
  };
}

/** Storage adapter over supabase-js (service role). */
export function supabaseStorage(supabase) {
  return {
    async replace({ prefixes, objects }) {
      for (const { bucket, folder } of prefixes) {
        const { data, error } = await supabase.storage.from(bucket).list(folder, { limit: 1000 });
        if (error) throw new Error(`storage list ${bucket}/${folder}: ${error.message}`);
        const files = (data ?? []).filter((f) => f.id).map((f) => `${folder}/${f.name}`);
        if (files.length) {
          const { error: removeError } = await supabase.storage.from(bucket).remove(files);
          if (removeError) throw new Error(`storage remove ${bucket}/${folder}: ${removeError.message}`);
        }
      }
      for (const { bucket, path, bytes, contentType } of objects) {
        const { error } = await supabase.storage
          .from(bucket)
          .upload(path, bytes, { contentType, upsert: true });
        if (error) throw new Error(`storage upload ${bucket}/${path}: ${error.message}`);
      }
    },
  };
}
