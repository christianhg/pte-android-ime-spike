# pte-android-ime-spike

Runs real Gboard against the Portable Text Editor on an Android emulator in GitHub Actions, to catch Android IME bugs without a physical device.

It was built for one bug: on Android, the first character typed with Gboard into an empty block can be lost or doubled, because a second `compositionstart` arrives while the first composition is still open. The workflow types into the editor the way a person does, by tapping Gboard's keys, and records every input and composition event the page sees.

## What a run does

Each job boots an API 34 emulator with the Play Store image, so the Gboard is the real one that ships on phones. It opens Chrome and runs three cases:

1. `plain.html`: a bare `contenteditable` with no editor, as the control.
2. `editor.html`: the editor with one empty block.
3. `editor.html?prefix=x`: the editor with one block that already holds `x`.

In each case it taps the field, waits for Gboard, taps `k`, `y`, `o`, `u` and Space twice (two words), then reads the editor value and the event log over the Chrome DevTools protocol.

The run matrix compares editor builds:

1. `baseline`: the published `@portabletext/editor` from `page/package.json`.
2. Any other variant: a packed tarball from `page/tarballs/<variant>.tgz`, built from a branch with `pnpm pack`.

With `IME_LANG=ja`, `scripts/setup_ja.py` first adds the Japanese QWERTY (romaji) layout through Gboard's settings screens, since the Play image has no root to change the locale.

## Reading the result

Each case prints a line like this in `drive.log`:

```
RESULT editor-empty: text='Kyou kyou ' picked=space/space compositionstart=3 nested=1 second_word_compositionstart=1 lang=en
```

1. `text` is the editor value after typing.
2. `nested` counts `compositionstart` events that arrived while a composition was still open. Anything above 0 is the bug.
3. `second_word_compositionstart` shows whether Gboard composes the second word, after the first was committed.

Every job uploads an `out-<variant>-<lang>-<attempt>` artifact with the event log as JSON, screenshots before and after typing, accessibility dumps of Gboard, logcat and device diagnostics.

## Files

1. `.github/workflows/gboard-ime.yml` holds the matrix, the page build and the emulator boot, with one retry when the emulator never comes online.
2. `scripts/run-on-device.sh` runs inside the booted emulator. It waits out the post-boot ANR storm, turns off system error dialogs, sets up Chrome and runs the three cases.
3. `scripts/drive.py` drives one case with uiautomator2 and CDP.
4. `scripts/setup_ja.py` adds the Japanese keyboard.
5. `scripts/diagnose.sh` records device facts and never fails the job.
6. `page/` holds the test pages, bundled with esbuild.

## Known flakes

The emulator is slow on hosted runners. Each job takes about 10 minutes, and some fail before typing for reasons unrelated to the editor: the emulator never comes online, the CDP connection to Chrome drops, or Gboard renders only half its keys. A job that fails before typing tells you nothing about the editor, so read the `RESULT` lines, not the job status.
