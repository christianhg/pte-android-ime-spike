# pte-android-ime-spike

Runs real Gboard against the Portable Text Editor on an Android emulator in GitHub Actions, to catch Android IME bugs without a physical device.

It was built for one bug: on Android, the first character typed with Gboard into an empty block can be lost or doubled, because a second `compositionstart` arrives while the first composition is still open. The workflow types into the editor the way a person does, by tapping Gboard's keys, and records every input and composition event the page sees.

## What a run does

Each job boots an API 36 emulator with the Play Store image, so the Gboard is the real one that ships on phones. It opens Chrome and runs three cases:

1. `plain.html`: a bare `contenteditable` with no editor, as the control.
2. `editor.html`: the editor with one empty block.
3. `editor.html?prefix=x`: the editor with one block that already holds `x`.

In each case it taps the field, waits for Gboard, taps `k`, `y`, `o`, `u` and Space twice (two words), then reads the editor value and the event log over the Chrome DevTools protocol.

The run matrix compares editor builds:

1. `baseline`: the published `@portabletext/editor` from `page/package.json`.
2. Any other variant: a packed tarball from `page/tarballs/<variant>.tgz`, built from a branch with `pnpm pack`.

With `IME_LANG=ja`, `scripts/setup-ja.ts` first adds the Japanese QWERTY (romaji) layout through Gboard's settings screens, since the Play image has no root to change the locale.

## Reading the result

Each case prints a line like this in `drive.log`:

```
RESULT editor-empty: text='Kyou kyou ' picked=space/space compositionstart=3 nested=1 second_word_compositionstart=1 lang=en
```

1. `text` is the editor value after typing.
2. `nested` counts `compositionstart` events that arrived while a composition was still open. Anything above 0 is the bug.
3. `second_word_compositionstart` shows whether Gboard composes the second word, after the first was committed.

Every job uploads an `out-<variant>-<lang>-api<api>-<attempt>` artifact with the event log as JSON, screenshots before and after typing (JPEG, as the on-device server takes them), accessibility dumps of Gboard, logcat and device diagnostics. `phases.log` times each step of the shell script, and a line starting `RETRY` marks a case that failed once and ran again from a fresh Chrome, so the flake rate counts first attempts too.

## Files

1. `.github/workflows/gboard-ime.yml` holds the matrix, the page build and the emulator boot, with one retry when the emulator never comes online.
2. `scripts/run-on-device.sh` runs inside the booted emulator. It waits out the post-boot ANR storm, turns off system error dialogs, sets up Chrome and runs the three cases.
3. `scripts/drive.ts` drives one case through the uiautomator2 server and CDP.
4. `scripts/setup-ja.ts` adds the Japanese keyboard.
5. `scripts/serve.ts` serves the built pages to the emulator.
6. `scripts/lib/` holds the adb, uiautomator2, CDP and accessibility dump helpers.
7. `scripts/diagnose.sh` records device facts and never fails the job.
8. `page/` holds the test pages, bundled with esbuild.

## The driver

The driver is TypeScript run directly by Node 24, with no build step and no runtime dependencies. adb runs through `child_process`, CDP goes over the global `WebSocket` and `fetch` through `adb forward`.

For the screen it talks to the same on-device server the Python `uiautomator2` package used, `u2.jar` 0.4.1 from openatx. `scripts/fetch-u2-jar.ts` downloads it once per job and checks its hash, and the driver pushes it and starts it with `app_process`. Hierarchy dumps, taps, swipes and screenshots are the same JSON-RPC calls the Python driver made, so the timing around composition stays comparable with earlier runs.

To check the driver without an emulator:

```
npm ci
npx tsc --noEmit
npm test
```

The tests parse real accessibility dumps from CI runs and rebuild the `RESULT` lines those runs printed.

## Known flakes

The emulator is slow on hosted runners. Each job takes about 10 minutes, and some fail before typing for reasons unrelated to the editor: the emulator never comes online, the CDP connection to Chrome drops, or Gboard renders only half its keys. A job that fails before typing tells you nothing about the editor, so read the `RESULT` lines, not the job status.
