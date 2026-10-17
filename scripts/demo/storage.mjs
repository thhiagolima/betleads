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

const PAGE = 100;

/**
 * Every object under `folder` (recursive, paginated). supabase-js lists one
 * level at a time; entries without an `id` are sub-folders.
 */
export async function listAll(storageBucket, folder) {
  const files = [];
  const pending = [folder];
  while (pending.length) {
    const dir = pending.shift();
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await storageBucket.list(dir, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`storage list ${dir}: ${error.message}`);
      const entries = data ?? [];
      for (const entry of entries) {
        const full = `${dir}/${entry.name}`;
        if (entry.id) files.push(full);
        else pending.push(full);
      }
      if (entries.length < PAGE) break;
    }
  }
  // Defense in depth: never touch anything outside the demo prefix.
  return files.filter((f) => f.startsWith(`${folder}/`));
}

/** Storage adapter over supabase-js (service role). */
export function supabaseStorage(supabase) {
  return {
    async replace({ prefixes, objects }) {
      // A bucket that does not exist holds no source file to stand in for
      // (prod has no email-images bucket): skip it instead of failing.
      const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets();
      if (bucketsError) throw new Error(`storage list buckets: ${bucketsError.message}`);
      const existing = new Set((buckets ?? []).map((b) => b.name));
      prefixes = prefixes.filter((p) => existing.has(p.bucket));
      objects = objects.filter((o) => existing.has(o.bucket));
      for (const { bucket, folder } of prefixes) {
        const storageBucket = supabase.storage.from(bucket);
        const files = await listAll(storageBucket, folder);
        for (let i = 0; i < files.length; i += PAGE) {
          const { error: removeError } = await storageBucket.remove(files.slice(i, i + PAGE));
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
