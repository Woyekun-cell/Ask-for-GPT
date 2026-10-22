"""Launch local Python protocol fixtures without requiring a Windows file association."""
import os
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch


def enable_python_helpers(testcase, worker):
    if os.name != 'nt': return
    original = subprocess.Popen
    def launch(arguments, **kwargs):
        # Only fixture scripts are adapted. Product executable resolution is
        # unchanged and still receives an argument array with no shell.
        path = Path(arguments[0])
        if path.is_file() and path.read_bytes()[:22].startswith(b'#!/usr/bin/env python3'):
            arguments = [sys.executable, '-u', str(path), *arguments[1:]]
        return original(arguments, **kwargs)
    replacement = patch.object(worker.subprocess, 'Popen', side_effect=launch)
    replacement.start()
    testcase.addCleanup(replacement.stop)
