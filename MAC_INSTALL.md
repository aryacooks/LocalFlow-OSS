# Install LocalFlow on macOS

## First launch

1. Open the LocalFlow `.dmg`.
2. Drag **LocalFlow** into the **Applications** folder shown in the installer.
3. Eject the LocalFlow installer disk.
4. Open **Applications**, then open **LocalFlow**.
5. Follow the setup guide inside the app.

Do not keep running LocalFlow from the installer disk. macOS permissions and launch-at-login are more reliable when the app is installed in Applications.

## If macOS blocks the app

For an unsigned development build, Control-click LocalFlow in Applications, choose **Open**, then choose **Open** again. For a public release, sign and notarize the app so users do not need this workaround.

## Permissions LocalFlow needs

### Microphone

Required to record your voice.

Open **System Settings > Privacy & Security > Microphone**, then enable LocalFlow.

### Accessibility

Required to paste the transcript into the app you are using.

Open **System Settings > Privacy & Security > Accessibility**, then enable LocalFlow. If LocalFlow is not listed, click **+** and select it from Applications.

### Input Monitoring

Optional. This is needed only when you configure a mouse button as a dictation trigger. Keyboard shortcuts do not need it.

Open **System Settings > Privacy & Security > Input Monitoring**, then enable LocalFlow.

After changing a permission, return to LocalFlow. If macOS still shows the old status, quit LocalFlow completely and reopen it.

## Finish setup

1. Choose a microphone in **Settings**.
2. Download a speech model from **Language Model**. The model marked Active is the one LocalFlow uses.
3. Keep **Formatting options** off initially. It is optional and requires a separate local model.
4. Click a text field in another app.
5. Use the shortcut shown in **Shortcuts**, speak, then stop recording.

## Common fixes

- **No text appears:** Enable Accessibility and make sure a text field was focused before dictating.
- **No recording starts:** Enable Microphone access and choose a working input device in Settings.
- **Model missing or incomplete:** Delete it from Language Model and download it again on a stable connection.
- **Shortcut does nothing:** Pick another shortcut; the current one may be reserved by macOS or another app.
- **Mouse trigger does nothing:** Enable Input Monitoring, or use a keyboard shortcut instead.
- **App was updated or moved:** macOS may treat it as a different app. Recheck Microphone, Accessibility, and Input Monitoring permissions.

## Development command

From the actual project directory:

```bash
cd /Users/aryabysani/Documents/localflow/flowlocal
pnpm tauri dev
```
