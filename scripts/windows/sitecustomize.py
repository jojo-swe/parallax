import os
import signal

if not hasattr(os, "killpg"):
    os.killpg = lambda pid, sig: os.kill(pid, signal.SIGTERM)
if not hasattr(signal, "SIGKILL"):
    signal.SIGKILL = signal.SIGTERM
