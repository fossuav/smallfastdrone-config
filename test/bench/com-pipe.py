#!/usr/bin/env python3
"""Pipe a flight controller's serial port to stdio, for the bench harness.

Runs under *Windows* Python (python.exe) so it can open a COM port
directly. WSL cannot: attaching the board to Linux with usbipd works
until the board reboots, at which point it re-enumerates, usbipd drops
the attachment and the character device never comes back. Windows keeps
the COM number stable across that, so this is the only way to bench a
reboot -- which is the one thing SITL can never test.

Protocol, so the TypeScript side can treat it as a transport:

    stdout  raw bytes from the board (binary, unbuffered)
    stdin   raw bytes to the board
    stderr  line-oriented status: "open <PORT>", "closed", "error <msg>"

The port is reopened automatically after it drops, so a reboot shows up
as "closed" followed by "open" once the board is back.

Run (normally spawned by test/bench/serial-link.ts):

    python.exe com-pipe.py [COM4]

With no argument it finds the board by USB VID:PID and takes the
lowest-numbered port, which is the MAVLink interface (the higher one is
SLCAN).
"""

import os
import sys
import threading
import time

import serial
from serial.tools import list_ports

# ArduPilot's USB identity. Same pair every ChibiOS board enumerates with.
VID, PID = 0x1209, 0x5740
BAUD = 115200
# Short read timeout: long enough not to spin the CPU, short enough that
# MAVLink latency stays well under one heartbeat.
READ_TIMEOUT_S = 0.05


def status(msg):
    """Emit one status line on stderr. stdout is reserved for board bytes."""
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def find_port(requested):
    """Resolve which COM port to open, or None if the board isn't present."""
    if requested:
        return requested
    candidates = [p for p in list_ports.comports() if p.vid == VID and p.pid == PID]
    if not candidates:
        return None

    def com_number(p):
        tail = p.device[3:]
        return int(tail) if p.device.upper().startswith("COM") and tail.isdigit() else 0

    return sorted(candidates, key=com_number)[0].device


class Pipe(object):
    """Owns the serial port and both directions of the pump."""

    def __init__(self, requested):
        self.requested = requested
        self.ser = None
        self.stop = False

    def pump_to_stdout(self):
        """Board -> stdout, reopening the port whenever it goes away."""
        while not self.stop:
            if self.ser is None:
                port = find_port(self.requested)
                if port is None:
                    time.sleep(0.2)
                    continue
                try:
                    self.ser = serial.Serial(port, baudrate=BAUD,
                                             timeout=READ_TIMEOUT_S, write_timeout=1)
                except Exception:
                    # Windows holds the handle briefly after re-enumeration;
                    # keep trying rather than giving up on the first refusal.
                    time.sleep(0.2)
                    continue
                status("open %s" % port)
                continue

            try:
                waiting = self.ser.in_waiting
                data = self.ser.read(waiting if waiting else 1)
            except Exception as e:
                # The board rebooted or was unplugged. Drop the handle and
                # let the loop above find it again.
                try:
                    self.ser.close()
                except Exception:
                    pass
                self.ser = None
                status("closed %s" % e.__class__.__name__)
                continue

            if data:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()

    def pump_from_stdin(self):
        """stdin -> board. Writes during a reboot are dropped, not queued."""
        while True:
            chunk = os.read(0, 4096)
            if not chunk:
                return
            ser = self.ser
            if ser is None:
                continue
            try:
                ser.write(chunk)
            except Exception:
                pass


def main():
    requested = sys.argv[1] if len(sys.argv) > 1 else None

    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)

    pipe = Pipe(requested)
    reader = threading.Thread(target=pipe.pump_to_stdout)
    reader.daemon = True
    reader.start()
    try:
        pipe.pump_from_stdin()
    finally:
        pipe.stop = True


if __name__ == "__main__":
    main()
