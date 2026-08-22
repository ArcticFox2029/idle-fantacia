/* Keeping the screen awake where the Wake Lock API is not allowed.
 *
 * 🐛 [fixed 2026-08-22, CONFIRMED by the owner on the device: "ในมือถือ ใช้งานได้แล้ว ไม่ดับ"]
 * "จอกันดับยังใช้ไม่ได้", reported three times. Android over the plain-http LAN address, where
 * `navigator.wakeLock` does not exist at all (it needs a secure context, and --no-https is chosen
 * precisely to avoid the certificate warning).
 *
 * Confirmed working with the video route, so the https question is settled too: the fallback is
 * sufficient here and switching the server back to TLS for this reason alone is not needed.
 *
 * A playing <video> is how this was done before the Wake Lock API existed. Two things were wrong
 * with the first attempt here, and both are why it kept failing silently:
 *
 * 1. The clip had NO audio track and the element was muted. Android decides whether to hold the
 *    screen from whether playback is audible, so a silent muted video is exactly the case it
 *    ignores. The clip now carries a real (digitally silent) audio track and plays unmuted — the
 *    content is silence, so nothing is heard, but the platform now counts it as playback.
 *    The cost is honest and worth stating: unmuted playback takes audio focus, so music playing
 *    on the phone may duck or pause. Serving over https and using the real Wake Lock API has no
 *    such cost — this is the fallback, not the good path.
 *
 * 2. `play()` is refused without a user gesture, and the rejection was swallowed with nothing to
 *    retry it. One early failure left the fallback dead for the whole session. It now arms itself
 *    to try again on the next touch.
 *
 * Nothing is fetched: 64x64, one second, looping, inline as data URIs, generated with ffmpeg.
 */
const NoSleepVideo = (() => {
  let el = null;
  let wanted = false;        // has enable() been asked for and not since disabled
  let armed = false;         // gesture retry listener installed
  let lastError = "";        // why the last play() attempt failed, for the settings panel

  const CLIPS = [
    ["video/webm", "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAUgEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggGLTbuMU6uEHFO7a1OsggUK7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAyV0GNTGF2ZjYyLjEyLjEwMkSJiECPgAAAAAAAFlSua0CtrgEAAAAAAAA/14EBc8WInxyUicaJ8zKcgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4Q7msoA4JCwgUC6gUCagQJVsIRVuYEBrgEAAAAAAABc14ECc8WI80H4U5KVWAKcgQAitZyDdW5kiIEAhoZBX09QVVNWqoNjLqBWu4QExLQAg4EC4ZGfgQG1iEC/QAAAAAAAYmSBEGOik09wdXNIZWFkAQE4AUAfAAAAAAASVMNnQNpzc6BjwIBnyJpFo4dFTkNPREVSRIeNTGF2ZjYyLjEyLjEwMnNz2mPAi2PFiJ8clInGifMyZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4yOC4xMDIgbGlidnB4LXZwOWfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAHNz12PAi2PFiPNB+FOSlVgCZ8iiRaOHRU5DT0RFUkSHlUxhdmM2Mi4yOC4xMDIgbGlib3B1c2fIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDA4MDAwMDAwAB9DtnVCmeeBAKOLggAAgAgL5jsjq2Cjo4EAAICCSYNCAAPwA/YAOCQcGEoAADBgAABnP///VkVk7swAo4qCABWACAissw7Go4qCACmACAissw7Go4qCAD2ACAissw7Go4qCAFGACAissw7Go4qCAGWACAissw7Go4qCAHmACAissw7Go4qCAI2ACAissw7Go4qCAKGACAissw7Go4qCALWACAissw7Go4qCAMmACAissw7Go4qCAN2ACAissw7Go4qCAPGACAissw7Go4qCAQWACAissw7Go4qCARmACAissw7Go4qCAS2ACAissw7Go4qCAUGACAissw7Go4qCAVWACAissw7Go4qCAWmACAissw7Go4qCAX2ACAissw7Go4qCAZGACAissw7Go4qCAaWACAissw7Go4qCAbmACAissw7Go4qCAc2ACAissw7Go4qCAeGACAissw7Go4qCAfWACAissw7Go4qCAgmACAissw7Go4qCAh2ACAissw7Go4qCAjGACAissw7Go4qCAkWACAissw7Go4qCAlmACAissw7Go4qCAm2ACAissw7Go4qCAoGACAissw7Go4qCApWACAissw7Go4qCAqmACAissw7Go4qCAr2ACAissw7Go4qCAtGACAissw7Go4qCAuWACAissw7Go4qCAvmACAissw7Go4qCAw2ACAissw7Go4qCAyGACAissw7Go4qCAzWACAissw7Go4qCA0mACAissw7Go4qCA12ACAissw7Go4qCA3GACAissw7Go4qCA4WACAissw7Go4qCA5mACAissw7Go4qCA62ACAissw7Go4qCA8GACAissw7Go4qCA9WACAissw7GoJahioID6QAICKyzDsabgQd1ooQAzf5gHFO7a5G7j7OBALeK94EB8YICa/CBEA=="],
    ["video/mp4", "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAV9bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAjp0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGybWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAR1zdGJsAAAAuXN0c2QAAAAAAAAAAQAAAKlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAL2F2Y0MBQsAK/+EAF2dCwArZBCbARAAAAwAEAAADAAg8SJkgAQAFaMuDyyAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAUkAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAQAAQAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAACkgAAAAEAAAAUc3RjbwAAAAAAAAABAAAFwgAAAm10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAA+gAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAEAAABAAAAAAHlbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAfQAAAI0BVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAABkG1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABVHN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAgAEgICAF0AVAAAAAAAfQAAAAXcFgICABRWIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAAfQAAAAXcAAAAgc3R0cwAAAAAAAAACAAAACAAABAAAAAABAAADQAAAAChzdHNjAAAAAAAAAAIAAAABAAAAAQAAAAEAAAACAAAACAAAAAEAAAA4c3RzegAAAAAAAAAAAAAACQAAABUAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAABhzdGNvAAAAAAAAAAIAAAWtAAAIVAAAABpzZ3BkAQAAAHJvbGwAAAACAAAAAf//AAAAHHNiZ3AAAAAAcm9sbAAAAAEAAAAJAAAAAQAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTIuMTAyAAAACGZyZWUAAALPbWRhdN4CAExhdmM2Mi4yOC4xMDIAAjBADgAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAaZYiEBX///w9FAAFC3ycnJ1111111111114ABGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBw=="],
  ];

  function element() {
    if (el) return el;
    el = document.createElement("video");
    el.setAttribute("playsinline", "");      // required, or iOS takes the video fullscreen
    el.setAttribute("loop", "");
    el.setAttribute("title", "");
    // Deliberately NOT muted — see the note above. The audio track is digital silence.
    el.muted = false;
    el.volume = 1;
    // Off-screen rather than display:none — a hidden video is allowed to stop playing, and a video
    // that has stopped is a video that is no longer holding anything awake.
    el.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-1px;top:-1px";
    for (const [type, b64] of CLIPS) {
      const s = document.createElement("source");
      s.type = type;
      s.src = `data:${type};base64,${b64}`;
      el.appendChild(s);
    }
    document.body.appendChild(el);
    // Some engines stop a looping video at the very end rather than wrapping; nudging it back is
    // cheaper than trusting loop alone.
    el.addEventListener("timeupdate", () => { if (el.currentTime > 0.5) el.currentTime = 0; });
    // The platform can stop playback on its own (audio focus lost to a call, a policy change). If
    // that happens while the screen is still meant to be held, take the next gesture to resume.
    el.addEventListener("pause", () => { if (wanted) armGestureRetry(); });
    return el;
  }

  /* One listener for the life of the page, added only once it is actually needed. It stays because
   * playback can be refused more than once — a page can lose audio focus repeatedly — and the
   * handler costs a boolean check per touch. */
  function armGestureRetry() {
    if (armed) return;
    armed = true;
    const retry = () => { if (wanted && el && el.paused) attempt(); };
    for (const ev of ["pointerdown", "touchend", "click", "keydown"]) {
      document.addEventListener(ev, retry, { passive: true });
    }
  }

  async function attempt() {
    const v = element();
    try {
      await v.play();
      lastError = "";
      return true;
    } catch (e) {
      lastError = (e && e.name) || "play refused";
      // Unmuted playback is refused far more often than muted. Falling back keeps SOMETHING
      // playing: it will not hold the screen on Android, but it does on desktop and on iOS, and a
      // paused video holds nothing anywhere.
      try {
        v.muted = true;
        await v.play();
        lastError = "muted-fallback";
        return true;
      } catch (e2) {
        armGestureRetry();
        return false;
      }
    }
  }

  return {
    async enable() {
      wanted = true;
      return attempt();
    },
    disable() {
      wanted = false;
      if (!el) return;
      try { el.pause(); } catch (e) { /* already stopped */ }
    },
    /* What is actually happening, so the settings panel can say so instead of the owner and I
     * guessing across three rounds of "still does not work". */
    status() {
      return {
        wanted,
        playing: !!(el && !el.paused && !el.ended),
        muted: !!(el && el.muted),
        error: lastError,
      };
    },
  };
})();
