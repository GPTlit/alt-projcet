import "./lib/error-capture";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

const execFileAsync = promisify(execFile);

function runCommand(
  file: string,
  args: string[],
  timeoutMs = 30000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 15 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout || (err && "stdout" in err ? String((err as any).stdout) : "") || "",
          stderr: stderr || (err && "stderr" in err ? String((err as any).stderr) : "") || "",
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
        });
      },
    );
  });
}

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

interface YouTubeVideo {
  id: string;
  title: string;
  channel: string;
  duration?: string;
  thumbnail: string;
  views?: string;
}

async function searchYouTube(q: string): Promise<YouTubeVideo[]> {
  const cleanQ = q.trim();
  if (!cleanQ) return [];

  try {
    const ytRes = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    );
    const html = await ytRes.text();
    const match = html.match(/ytInitialData\s*=\s*({.+?});<\/script>/s);
    const videos: YouTubeVideo[] = [];

    if (match) {
      const data = JSON.parse(match[1]);
      const contents =
        data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer
          ?.contents?.[0]?.itemSectionRenderer?.contents || [];

      for (const item of contents) {
        const v = item.videoRenderer;
        if (v && v.videoId) {
          const thumb =
            v.thumbnail?.thumbnails?.[v.thumbnail.thumbnails.length - 1]?.url ||
            `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`;
          videos.push({
            id: v.videoId,
            title: v.title?.runs?.[0]?.text || "Untitled Video",
            channel: v.ownerText?.runs?.[0]?.text || "YouTube",
            duration: v.lengthText?.simpleText || "",
            thumbnail: thumb,
            views: v.viewCountText?.simpleText || "",
          });
        }
      }
    }

    return videos;
  } catch (err) {
    console.error("YouTube search error:", err);
    return [];
  }
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const url = new URL(request.url);

    if ((url.pathname === "/api/youtube/search" || url.pathname === "/api/video/search") && request.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const videos = await searchYouTube(q);
      return new Response(JSON.stringify({ videos }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/api/video/related" && request.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const currentId = url.searchParams.get("id") || "";
      const videos = await searchYouTube(q);
      const filtered = videos.filter((v) => v.id !== currentId);
      return new Response(JSON.stringify({ videos: filtered }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/api/proxy-image" && request.method === "GET") {
      const imgUrl = url.searchParams.get("url");
      if (!imgUrl) return new Response("Missing url", { status: 400 });
      try {
        const res = await fetch(imgUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });
        const blob = await res.arrayBuffer();
        const contentType = res.headers.get("content-type") || "image/jpeg";
        return new Response(blob, {
          headers: {
            "content-type": contentType,
            "cache-control": "public, max-age=86400",
            "access-control-allow-origin": "*",
          },
        });
      } catch {
        return new Response("Failed to fetch image", { status: 500 });
      }
    }

    if (url.pathname === "/api/video/info" && request.method === "GET") {
      const q = (url.searchParams.get("url") || url.searchParams.get("q") || "").trim();
      if (!q) {
        return new Response(JSON.stringify({ error: "Missing URL or query" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const match = q.match(
        /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([\w-]{10,12})/,
      );
      const videoId = match ? match[1] : /^[\w-]{10,12}$/.test(q) ? q : "";

      if (videoId) {
        // High-speed oEmbed extraction first (50ms response time, immune to bot detection)
        try {
          const oembedRes = await fetch(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
          );
          if (oembedRes.ok) {
            const data = (await oembedRes.json()) as {
              title: string;
              author_name: string;
              thumbnail_url: string;
            };
            return new Response(
              JSON.stringify({
                video: {
                  id: videoId,
                  title: data.title || "YouTube Song",
                  channel: data.author_name || "YouTube",
                  thumbnail:
                    data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                },
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
        } catch {
          // ignore and fallback to yt-dlp
        }

        try {
          const binaryPath = path.resolve(process.cwd(), "bin/yt-dlp");
          const { stdout } = await execFileAsync(
            "python3",
            [
              binaryPath,
              "--no-js-runtimes",
              "--js-runtimes",
              "node",
              "--no-check-certificates",
              "--geo-bypass",
              "--no-playlist",
              "--dump-json",
              `https://www.youtube.com/watch?v=${videoId}`,
            ],
            { timeout: 15000 },
          );

          const info = JSON.parse(stdout) as {
            title?: string;
            uploader?: string;
            channel?: string;
            duration?: number;
            duration_string?: string;
            thumbnail?: string;
          };

          return new Response(
            JSON.stringify({
              video: {
                id: videoId,
                title: info.title || "YouTube Video",
                channel: info.uploader || info.channel || "YouTube",
                duration:
                  info.duration_string ||
                  (info.duration
                    ? `${Math.floor(info.duration / 60)}:${(info.duration % 60).toString().padStart(2, "0")}`
                    : ""),
                thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        } catch {
          return new Response(
            JSON.stringify({
              video: {
                id: videoId,
                title: "YouTube Video",
                channel: "YouTube",
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
      }

      // If it's a non-YouTube URL (e.g. TikTok, SoundCloud, Twitter)
      try {
        const binaryPath = path.resolve(process.cwd(), "bin/yt-dlp");
        const { stdout } = await execFileAsync(
          "python3",
          [
            binaryPath,
            "--no-check-certificates",
            "--geo-bypass",
            "--no-playlist",
            "--dump-json",
            q,
          ],
          { timeout: 15000 },
        );
        const info = JSON.parse(stdout) as {
          id?: string;
          title?: string;
          uploader?: string;
          thumbnail?: string;
          duration_string?: string;
        };
        return new Response(
          JSON.stringify({
            video: {
              id: info.id || Math.random().toString(36).substring(2, 10),
              title: info.title || "Web Media",
              channel: info.uploader || "Web Audio",
              duration: info.duration_string || "",
              thumbnail:
                info.thumbnail ||
                "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&auto=format&fit=crop",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      } catch {
        return new Response(
          JSON.stringify({
            video: {
              id: Math.random().toString(36).substring(2, 10),
              title: "Web Media",
              channel: "Web Download",
              thumbnail:
                "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=600&auto=format&fit=crop",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
    }

    if (url.pathname === "/api/video/download" && request.method === "GET") {
      let rawId = url.searchParams.get("id") || "";
      const rawUrl = (url.searchParams.get("url") || "").trim();
      if (rawUrl) {
        const match = rawUrl.match(
          /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([\w-]{10,12})/,
        );
        if (match) {
          rawId = match[1];
        } else if (/^[\w-]{10,12}$/.test(rawUrl)) {
          rawId = rawUrl;
        }
      }

      const id = rawId.trim();
      const type = url.searchParams.get("type") || "audio";
      const quality = url.searchParams.get("quality") || (type === "audio" ? "320" : "720");
      let rawTitle = url.searchParams.get("title") || "";

      // If title is missing or default, attempt fast oEmbed lookup
      if ((!rawTitle || rawTitle === "download" || rawTitle === "spoiled-song") && id) {
        try {
          const oe = await fetch(
            `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`,
          );
          if (oe.ok) {
            const jd = (await oe.json()) as { title?: string };
            if (jd.title) rawTitle = jd.title;
          }
        } catch {
          // ignore
        }
      }

      if (!rawTitle) rawTitle = id ? `Track ${id}` : "spoiled-track";
      const cleanTitle = rawTitle.replace(/[^\w\s.-]/gi, "").trim() || "spoiled-song";
      const searchTitle = rawTitle
        .replace(/\(.*?\)|\[.*?\]/g, "")
        .replace(/official\s*(music\s*)?video/gi, "")
        .replace(/ft\..*|feat\..*/gi, "")
        .replace(/lyrics?/gi, "")
        .replace(/audio/gi, "")
        .replace(/[^\w\s.-]/gi, " ")
        .trim();

      const binaryPath = path.resolve(process.cwd(), "bin/yt-dlp");
      try {
        fs.chmodSync(binaryPath, 0o755);
      } catch {
        // ignore
      }

      const targetVideo = id ? `https://www.youtube.com/watch?v=${id}` : rawUrl;
      if (!targetVideo) {
        return new Response(JSON.stringify({ error: "Missing video ID or URL" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }

      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const filePrefix = path.resolve("/tmp", `spoiled_${timestamp}_${randomSuffix}`);

      let downloadedFilePath: string | null = null;
      let finalExt = type === "audio" ? "mp3" : "mp4";
      const bitrate = quality === "192" ? "192K" : quality === "128" ? "128K" : "320K";

      // ATTEMPT 1: Direct yt-dlp download
      try {
        let directArgs: string[] = [];
        if (type === "audio") {
          finalExt = "mp3";
          directArgs = [
            "--no-js-runtimes",
            "--js-runtimes",
            "node",
            "--no-check-certificates",
            "--geo-bypass",
            "--no-playlist",
            "-f",
            "bestaudio/best[height<=720]/18/b",
            "-x",
            "--audio-format",
            "mp3",
            "--audio-quality",
            bitrate,
            "-o",
            `${filePrefix}.mp3`,
            targetVideo,
          ];
        } else {
          finalExt = "mp4";
          const height = ["1080", "720", "480", "360"].includes(quality) ? quality : "720";
          directArgs = [
            "--no-js-runtimes",
            "--js-runtimes",
            "node",
            "--no-check-certificates",
            "--geo-bypass",
            "--no-playlist",
            "-f",
            `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best/18/b`,
            "--merge-output-format",
            "mp4",
            "-o",
            `${filePrefix}.mp4`,
            targetVideo,
          ];
        }

        await runCommand("python3", [binaryPath, ...directArgs], 15000);

        if (fs.existsSync(`${filePrefix}.${finalExt}`) && fs.statSync(`${filePrefix}.${finalExt}`).size > 1000) {
          downloadedFilePath = `${filePrefix}.${finalExt}`;
        } else {
          // Check for any file starting with filePrefix in /tmp
          const dirFiles = await fs.promises.readdir("/tmp").catch(() => []);
          const found = dirFiles.find((f) => f.startsWith(`spoiled_${timestamp}_${randomSuffix}`) && !f.endsWith(".part") && !f.endsWith(".ytdl"));
          if (found) {
            const candidate = path.resolve("/tmp", found);
            if (fs.existsSync(candidate) && fs.statSync(candidate).size > 1000) {
              downloadedFilePath = candidate;
              finalExt = path.extname(found).replace(".", "") || finalExt;
            }
          }
        }
      } catch (directErr) {
        console.warn("Direct download attempt failed, trying fallback...", directErr);
      }

      // ATTEMPT 2: Fallback for audio via SoundCloud search (immune to YouTube bot detection)
      if (!downloadedFilePath && type === "audio" && (searchTitle || rawTitle)) {
        try {
          const query = searchTitle || rawTitle;
          const { stdout: scJson } = await runCommand(
            "python3",
            [
              binaryPath,
              "--ignore-errors",
              "--dump-json",
              `scsearch8:${query}`,
            ],
            25000,
          );

          const lines = scJson.trim().split("\n");
          const candidates: { webpage_url: string; title?: string; duration: number }[] = [];
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const scTrack = JSON.parse(line) as { webpage_url?: string; title?: string; duration?: number };
              if (scTrack.webpage_url) {
                candidates.push({
                  webpage_url: scTrack.webpage_url,
                  title: scTrack.title,
                  duration: scTrack.duration || 0,
                });
              }
            } catch {
              // ignore
            }
          }

          // Prioritize standard song durations (~3.5 minutes) over hour-long DJ mixes
          candidates.sort((a, b) => {
            const diffA = a.duration > 0 ? Math.abs(a.duration - 210) : 999;
            const diffB = b.duration > 0 ? Math.abs(b.duration - 210) : 999;
            return diffA - diffB;
          });

          for (const cand of candidates) {
            try {
              const scTargetFile = `${filePrefix}_sc.mp3`;
              await runCommand(
                "python3",
                [
                  binaryPath,
                  "-f",
                  "bestaudio/best",
                  "-x",
                  "--audio-format",
                  "mp3",
                  "--audio-quality",
                  bitrate,
                  "-o",
                  scTargetFile,
                  cand.webpage_url,
                ],
                25000,
              );

              if (fs.existsSync(scTargetFile) && fs.statSync(scTargetFile).size > 1000) {
                downloadedFilePath = scTargetFile;
                finalExt = "mp3";
                break;
              }
            } catch {
              // try next candidate
            }
          }
        } catch (scErr) {
          console.warn("SoundCloud fallback search failed:", scErr);
        }
      }

      // ATTEMPT 3: YouTube Search Alternate Audio/Lyrics uploads
      if (!downloadedFilePath && type === "audio" && (searchTitle || rawTitle)) {
        try {
          const query = `${searchTitle || rawTitle} audio`;
          const { stdout: ytJson } = await runCommand(
            "python3",
            [
              binaryPath,
              "--no-js-runtimes",
              "--js-runtimes",
              "node",
              "--no-check-certificates",
              "--geo-bypass",
              "--ignore-errors",
              "--dump-json",
              `ytsearch4:${query}`,
            ],
            25000,
          );

          const lines = ytJson.trim().split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const ytTrack = JSON.parse(line) as { webpage_url?: string; id?: string };
              const trackUrl = ytTrack.webpage_url || (ytTrack.id ? `https://www.youtube.com/watch?v=${ytTrack.id}` : null);
              if (!trackUrl || (id && trackUrl.includes(id))) continue;

              const ytTargetFile = `${filePrefix}_alt.mp3`;
              await runCommand(
                "python3",
                [
                  binaryPath,
                  "--no-js-runtimes",
                  "--js-runtimes",
                  "node",
                  "-f",
                  "bestaudio/best[height<=720]/18/b",
                  "-x",
                  "--audio-format",
                  "mp3",
                  "--audio-quality",
                  bitrate,
                  "-o",
                  ytTargetFile,
                  trackUrl,
                ],
                30000,
              );

              if (fs.existsSync(ytTargetFile) && fs.statSync(ytTargetFile).size > 1000) {
                downloadedFilePath = ytTargetFile;
                finalExt = "mp3";
                break;
              }
            } catch {
              // try next candidate
            }
          }
        } catch (ytErr) {
          console.warn("YouTube alternate search failed:", ytErr);
        }
      }

      // ATTEMPT 4: Video fallback with standard format 18
      if (!downloadedFilePath && type === "video") {
        try {
          const vTarget = `${filePrefix}_f18.mp4`;
          await runCommand(
            "python3",
            [
              binaryPath,
              "--no-js-runtimes",
              "--js-runtimes",
              "node",
              "-f",
              "18/best/b",
              "-o",
              vTarget,
              targetVideo,
            ],
            35000,
          );
          if (fs.existsSync(vTarget) && fs.statSync(vTarget).size > 1000) {
            downloadedFilePath = vTarget;
            finalExt = "mp4";
          }
        } catch {
          // ignore
        }
      }

      if (!downloadedFilePath || !fs.existsSync(downloadedFilePath)) {
        return new Response(
          JSON.stringify({
            error: "Download could not be completed for this media",
            message: "Download could not be completed. Please try another track or link.",
          }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        );
      }

      try {
        const fileBuffer = await fs.promises.readFile(downloadedFilePath);
        await fs.promises.unlink(downloadedFilePath).catch(() => {});

        const contentType =
          type === "audio"
            ? finalExt === "mp3"
              ? "audio/mpeg"
              : finalExt === "m4a"
                ? "audio/mp4"
                : "audio/mpeg"
            : "video/mp4";
        const filename = `${cleanTitle}.${finalExt}`;

        return new Response(fileBuffer, {
          headers: {
            "content-type": contentType,
            "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "content-length": fileBuffer.byteLength.toString(),
            "access-control-allow-origin": "*",
          },
        });
      } catch (readErr) {
        console.error("File send error:", readErr);
        return new Response(
          JSON.stringify({ error: "Failed to read downloaded file" }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
    }

    if (url.pathname === "/api/assistant" && request.method === "POST") {
      try {
        const body = (await request.json()) as { prompt?: string; library?: unknown[] };
        const prompt = body.prompt || "";
        const library = body.library || [];

        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
          const { GoogleGenAI } = await import("@google/genai");
          const ai = new GoogleGenAI();
          const response = await ai.models.generateContent({
            model: "gemini-3.8-flash",
            contents: `User prompt: ${prompt}\nUser Library sample: ${JSON.stringify(library.slice(0, 15))}`,
            config: {
              systemInstruction: `You are the SPOILED Music Curator, a knowledgeable, refined, and passionate music concierge for the SPOILED personal audio player.
Analyze the user's inquiry, taste, and their local library context.
Respond with insightful music commentary and provide 3-5 structured track recommendations.
Format your output strictly as a JSON object:
{
  "reply": "Your articulate, conversational response as the SPOILED curator...",
  "recommendations": [
    {
      "title": "Song Title",
      "artist": "Artist Name",
      "vibe": "e.g. Dreamy / Late Night / Ethereal",
      "reason": "Why this song fits the user's prompt"
    }
  ]
}`,
              responseMimeType: "application/json",
            },
          });

          const text = response.text || "{}";
          const parsed = JSON.parse(text) as {
            reply?: string;
            recommendations?: Array<{
              title: string;
              artist: string;
              vibe: string;
              reason: string;
            }>;
          };
          return new Response(
            JSON.stringify({
              reply: parsed.reply || text,
              recommendations: parsed.recommendations || [],
            }),
            { headers: { "content-type": "application/json" } },
          );
        }

        // Curated fallback recommendations if GEMINI_API_KEY is not configured
        return new Response(
          JSON.stringify({
            reply: `Here are bespoke selections curated for "${prompt}":`,
            recommendations: [
              {
                title: "Midnight City",
                artist: "M83",
                vibe: "Euphoric Synthwave",
                reason: "Rich atmospheric layers and soaring melodies for late-night immersion.",
              },
              {
                title: "White Ferrari",
                artist: "Frank Ocean",
                vibe: "Intimate Ambient Soul",
                reason: "Minimal acoustic framing and haunting vocal harmonics.",
              },
              {
                title: "Weightless",
                artist: "Marconi Union",
                vibe: "Restorative Ambient",
                reason: "Scientifically engineered soundscapes that evoke liquid tranquility.",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      } catch (err) {
        console.error("AI Assistant error", err);
        return new Response(
          JSON.stringify({
            reply:
              "I am ready to curate music for your collection. What vibe or artist are you exploring?",
            recommendations: [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
    }

    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
