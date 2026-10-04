import { parseBlob } from "music-metadata";

export interface ParsedAudioMetadata {
  title: string;
  artist: string;
  album: string;
  year?: number;
  genre?: string;
  trackNumber?: number;
  duration?: number;
  pictureBlob?: Blob;
  pictureUrl?: string;
}

export function parseFilename(name: string): { title: string; artist: string } {
  // Strip common audio extensions
  const base = name
    .replace(/\.(mp3|flac|wav|m4a|ogg|aac|wma|aiff|opus)$/i, "")
    .replace(/_/g, " ")
    .trim();

  // Check for "Artist - Title" or "TrackNo. Artist - Title" or "TrackNo - Title"
  const cleaned = base.replace(/^\d+[\s.-]+/, "").trim();
  const parts = cleaned.split(/\s*[-–—]\s*/);

  if (parts.length >= 2 && parts[0] && parts[1]) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(" - ").trim(),
    };
  }

  return {
    artist: "Unknown Artist",
    title: cleaned || base || "Untitled Track",
  };
}

export async function extractAudioMetadata(file: File): Promise<ParsedAudioMetadata> {
  const fallback = parseFilename(file.name);
  const folder = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    ?.split("/")
    .slice(-2, -1)[0];

  try {
    const meta = await parseBlob(file, { duration: true, skipCovers: false });
    const common = meta.common;
    const format = meta.format;

    let pictureBlob: Blob | undefined;
    let pictureUrl: string | undefined;

    if (common.picture && common.picture.length > 0) {
      const pic = common.picture[0]!;
      const mime = pic.format || "image/jpeg";
      // Ensure we create a clean Blob from the picture buffer
      pictureBlob = new Blob([pic.data as BlobPart], { type: mime });
      pictureUrl = URL.createObjectURL(pictureBlob);
    }

    return {
      title: common.title?.trim() || fallback.title,
      artist: common.artist?.trim() || fallback.artist,
      album: common.album?.trim() || folder || "Singles",
      year: common.year,
      genre: common.genre?.[0],
      trackNumber: common.track?.no ?? undefined,
      duration: format.duration && isFinite(format.duration) ? format.duration : undefined,
      pictureBlob,
      pictureUrl,
    };
  } catch (err) {
    console.warn("Could not read ID3 metadata for", file.name, err);
    return {
      title: fallback.title,
      artist: fallback.artist,
      album: folder || "Singles",
    };
  }
}
