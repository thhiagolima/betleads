// Fix round (item 9): the reset wipes every object under the demo prefixes —
// nested folders, more than one page — and nothing outside them.
import { describe, expect, it } from "vitest";

import { supabaseStorage } from "./storage.mjs";

function fakeSupabase(paths: string[], buckets = ["call-audios", "email-images"]) {
  const objects = new Map(paths.map((p) => [p, true]));
  const uploads: string[] = [];
  const bucket = (name: string) => ({
    async list(dir: string, { limit, offset }: { limit: number; offset: number }) {
      const prefix = `${name}/${dir}/`;
      const children = new Map<string, boolean>();
      for (const key of objects.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        children.set(head, tail.length === 0 || children.get(head) === true);
      }
      const entries = [...children]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([entry, isFile]) => ({ name: entry, id: isFile ? `id-${entry}` : null }));
      return { data: entries.slice(offset, offset + limit), error: null };
    },
    async remove(files: string[]) {
      for (const f of files) objects.delete(`${name}/${f}`);
      return { error: null };
    },
    async upload(path: string) {
      uploads.push(`${name}/${path}`);
      objects.set(`${name}/${path}`, true);
      return { error: null };
    },
  });
  const listBuckets = async () => ({ data: buckets.map((name) => ({ name })), error: null });
  return { client: { storage: { from: bucket, listBuckets } }, objects, uploads };
}

describe("supabaseStorage.replace", () => {
  it("removes nested and paginated objects under the prefixes only, then uploads", async () => {
    const many = Array.from(
      { length: 250 },
      (_, i) => `call-audios/T/journeys/a${String(i).padStart(3, "0")}.mp3`,
    );
    const { client, objects, uploads } = fakeSupabase([
      ...many,
      "call-audios/T/demo/sub/deep/x.mp3",
      "call-audios/T/demo/placeholder.mp3",
      "call-audios/T/other/keep.mp3",
      "call-audios/OTHER/demo/keep.mp3",
      "email-images/T/img/a.png",
      "email-images/U/keep.png",
    ]);
    await supabaseStorage(client).replace({
      prefixes: [
        { bucket: "call-audios", folder: "T/demo" },
        { bucket: "call-audios", folder: "T/journeys" },
        { bucket: "email-images", folder: "T" },
      ],
      objects: [
        {
          bucket: "call-audios",
          path: "T/demo/placeholder.mp3",
          bytes: Buffer.from("x"),
          contentType: "audio/mpeg",
        },
      ],
    });
    expect([...objects.keys()].sort()).toEqual(
      [
        "call-audios/OTHER/demo/keep.mp3",
        "call-audios/T/demo/placeholder.mp3",
        "call-audios/T/other/keep.mp3",
        "email-images/U/keep.png",
      ].sort(),
    );
    expect(uploads).toEqual(["call-audios/T/demo/placeholder.mp3"]);
  });

  it("skips a bucket that does not exist (prod has no email-images)", async () => {
    const { client, uploads } = fakeSupabase(["call-audios/T/demo/old.mp3"], ["call-audios"]);
    await supabaseStorage(client).replace({
      prefixes: [
        { bucket: "call-audios", folder: "T/demo" },
        { bucket: "email-images", folder: "T" },
      ],
      objects: [
        { bucket: "call-audios", path: "T/demo/placeholder.mp3", bytes: Buffer.from("x"), contentType: "audio/mpeg" },
        { bucket: "email-images", path: "T/placeholder.png", bytes: Buffer.from("x"), contentType: "image/png" },
      ],
    });
    expect(uploads).toEqual(["call-audios/T/demo/placeholder.mp3"]);
  });
});
