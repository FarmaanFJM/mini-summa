#!/usr/bin/env python3
"""Linux/macOS helper that plays the human for the idle-session qualification tests (stdlib only).
It runs a command in a pseudo-terminal, accepts the first-run onboarding and the folder-trust prompt for the
folder you pass, then leaves the session idle. It never types a prompt, so no model tokens are used.
usage: pty-drive.py CWD LOGFILE MAX_SECONDS EXIT_AFTER_SECONDS -- CMD [ARGS...]
  EXIT_AFTER_SECONDS: after the session has been idle that long, type /exit (0 = never; wait to be killed)"""
import os, pty, re, select, struct, subprocess, sys, time, fcntl, termios
cwd, log, max_s, exit_after = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
cmd = sys.argv[sys.argv.index('--') + 1:]
m, s = pty.openpty()
fcntl.ioctl(s, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 140, 0, 0))
p = subprocess.Popen(cmd, cwd=cwd, stdin=s, stdout=s, stderr=s, close_fds=True, preexec_fn=os.setsid)
os.close(s)
out = open(log, 'wb')
ansi = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]')
typed = False; screen = ''; last_action = 0.0; t0 = time.time(); idle_since = None
while p.poll() is None and time.time() - t0 < max_s:
    r, _, _ = select.select([m], [], [], 0.3)
    if r:
        try: d = os.read(m, 65536)
        except OSError: break
        if not d: break
        out.write(d); out.flush()
        screen = (screen + ansi.sub('', d.decode('utf8', 'replace')))[-4000:]
    now = time.time()
    flat = re.sub(r'\s+', '', screen)
    if now - last_action > 2.0:
        if 'trustthisfolder' in flat.lower() or 'Yes,Itrust' in flat:
            os.write(m, b'\x1b[B'); time.sleep(0.5); os.write(m, b'\r'); last_action = now; screen = ''; idle_since = None
        elif 'PressEntertocontinue' in flat or 'Entertoconfirm' in flat:
            os.write(m, b'\r'); last_action = now; screen = ''
        elif 'Choosethetextstyle' in flat or 'Syntaxtheme' in flat:
            os.write(m, b'\r'); last_action = now; screen = ''
    if idle_since is None and ('?forshortcuts' in flat or 'medium' in flat and '/effort' in flat):
        idle_since = now
    if os.environ.get('PTY_TYPE') and idle_since and now - idle_since > 4 and not typed:
        os.write(m, os.environ['PTY_TYPE'].encode()); time.sleep(0.5); os.write(m, b'\r'); typed = True
    if exit_after and idle_since and now - idle_since > exit_after:
        os.write(m, b'/exit\r'); exit_after = 0
if p.poll() is None:
    try: os.write(m, b'/exit\r'); time.sleep(3)
    except OSError: pass
if p.poll() is None: p.terminate()
try: p.wait(timeout=3)
except Exception: pass
print('driver exit:', p.poll())
