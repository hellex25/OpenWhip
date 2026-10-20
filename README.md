# OpenWhip

![Whip divider](assets/divider.png)

Sometimes claude code is going too shlow, and you must whip him into shape..

## Install + run

```bash
npm install -g openwhip
openwhip
```

It lives in your tray / menu bar. Windows and mac are supported out of the box, but Linux is a special snowflake so you need to install `xdotool` for keyboard automation (and front-window detection):

```bash
sudo apt install xdotool
```

**macOS:** the first crack will ask for Accessibility (and Automation → System Events) permission so OpenWhip can type into your terminal. Grant it in System Settings → Privacy & Security, or nothing gets typed.

**Windows:** works with Windows Terminal, PowerShell, cmd, Git Bash and WSL out of the box, on any keyboard layout. Tick **Start with Windows** in the tray menu to have it waiting at login. Running Claude Code in an admin terminal? Run OpenWhip as admin too, or Windows silently blocks the keystrokes.

Running from source:

```bash
git clone https://github.com/GitFrog1111/OpenWhip.git
cd OpenWhip
npm install
npm start
```

## Controls

- Click tray icon (or press `Ctrl+Alt+W` anywhere): spawn whip on whichever screen your cursor is on (full-screen spaces on macOS included).
- Click (or `Ctrl+Alt+W` again): drop whip.
- Whip him 😩💢
- It sends an interrupt (Esc by default, or Ctrl-C) and one of 16 encouraging messages that tell Claude to get back to work, faster!
- It only whips terminals: if your browser or Slack is in front, the crack is just for show.
- Right-click the tray icon for the menu:
  - **Whips today / all time**: your tally (also shown in the tray tooltip).
  - **Send keystrokes**: untick for practice mode, all crack and no typing.
  - **Only whip terminals**: untick to type into whatever app is in front (at your own risk).
  - **Interrupt with**: Esc (recommended) or Ctrl+C. Heads up: Ctrl+C twice quits Claude Code, so Esc is the default.
  - **Crack sound**: mute the crack.
  - **Edit messages & terminal list…**: see below.
  - **Reset whip count**: wipe the evidence.
  - **Start with Windows** (Windows only): launch at login.

## Customise

Tray menu → **Edit messages & terminal list…** opens `config.json`:

- `messages`: what gets typed after the interrupt. Repeat a line to make it more likely.
- `terminalApps`: names that count as a terminal (matched against the app name on macOS, window class on Linux, `.exe` on Windows). Running Claude Code in VS Code or Cursor's terminal? Add `"code"` or `"cursor"`. LM Studio is on the list by default, so you can whip local models too (click into its chat box first).

Edits apply on the next crack, no restart needed. If the file is broken JSON, OpenWhip quietly falls back to the defaults.

Settings and whip counts are stored next to it in `state.json`, inside Electron's userData folder (`~/Library/Application Support/openwhip` on macOS, `%APPDATA%\openwhip` on Windows, `~/.config/openwhip` on Linux).

## Troubleshooting

- **Whip cracks but nothing gets typed:** the front app probably isn't in `terminalApps` (common with editor terminals), keystrokes are turned off, or on macOS Accessibility permission is missing.
- **`Ctrl+Alt+W` does nothing:** another app already owns that shortcut. Use the tray icon instead.
- **Windows: nothing typed into an admin terminal:** run OpenWhip as administrator too.

## Roadmap

- [x] Initial release! 🥳
- [x] Cease and desist letter from Anthropic
- [ ] Crypto miner
- [x] Logs of how many times you whipped claude so when the robots come we can order people nicely for them
- [ ] Updated whip physics (now refresh-rate independent, at least)

## Ecosystem

The OFFICAL openwhip ecosystem token. 

Contract address: BRyUZbJkm9Pty4FUmTrBGno7U4Ga8TWzcKJJRLCBpump

Stay tuned for updates on X! 👀
https://x.com/blended_jpeg