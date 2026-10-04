<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

- Keep SPOILED's local audio files in browser IndexedDB and reconstruct object URLs at startup, because file-backed songs must survive reload without a remote account.
- Keep the prototype-inspired screens in the existing single TanStack index route with internal screen state, because playback must persist while the listener switches views.
- Treat editorial artwork as illustrative only and never present it as a playable imported song, because music and recommendations must reflect actual user files.
- Store Google account profiles in the Cloud profiles table while keeping audio and playlists on the device, because signing in must not silently upload personal music.
- Read audio tags with the browser-native `music-metadata` package (not `music-metadata-browser`), because the old package's Node stream polyfills crash the production bundle.

- Keep the Capacitor Android shell pointed at the published app and avoid claiming native media controls until a tested foreground playback service exists, because Web Media Session alone does not guarantee Android background playback.
