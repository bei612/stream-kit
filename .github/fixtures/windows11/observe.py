"""Observe an owned QEMU guest through its control socket and private UART."""
import base64
import json
import os
import re
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def verify_guest_clock(result, evidence_file):
    now = datetime.now(timezone.utc)
    guest = datetime.fromisoformat(result['guest_utc'].replace('Z', '+00:00'))
    skew_seconds = (guest - now).total_seconds()
    result.update(observer_utc=now.isoformat(), clock_skew_seconds=round(skew_seconds, 2))
    evidence_file.write_text(json.dumps(result, indent=2) + '\n')
    if result.get('guest_time_zone') != 'UTC' or abs(skew_seconds) > 60:
        raise RuntimeError(f'Guest clock must match the acceptance host before TLS checks (skew {skew_seconds:+.1f} seconds)')


def main():
    qmp_path, serial_path, output_path, pid, *lan = sys.argv[1:]
    if len(lan) > 1:
        raise ValueError('Expected at most one owned LAN adapter MAC address')
    serial = Path(serial_path)
    output = Path(output_path)
    waiting_for = 'initial Windows setup'
    deadline = time.monotonic() + 60 * 60
    control = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    control.settimeout(5)
    for attempt in range(40):
        try:
            control.connect(qmp_path)
            break
        except (FileNotFoundError, ConnectionRefusedError):
            os.kill(int(pid), 0)
            time.sleep(0.25)
    else:
        raise RuntimeError('QEMU did not open its private control socket')

    with control, control.makefile('rwb', buffering=0) as messages:
        hello = json.loads(messages.readline())
        assert 'QMP' in hello

        def command(name, args=None):
            data = {'execute': name}
            if args:
                data['arguments'] = args
            messages.write(json.dumps(data).encode('ascii') + b'\n')
            while True:
                response = json.loads(messages.readline())
                if 'event' not in response:
                    if 'error' in response:
                        raise RuntimeError(response['error']['desc'])
                    return response['return']

        command('qmp_capabilities')
        # The stock boot DVD waits for a key. Send it only on initial firmware startup.
        for _ in range(18):
            command('human-monitor-command', {'command-line': 'sendkey ret'})
            time.sleep(0.7)

        offset = 0
        partial = b''
        phases = set()
        checkpoint = None
        try:
            while time.monotonic() < deadline:
                os.kill(int(pid), 0)
                if serial.exists():
                    with serial.open('rb') as data:
                        data.seek(offset)
                        partial += data.read(256 * 1024)
                        offset = data.tell()
                    lines = partial.split(b'\n')
                    partial = lines.pop()
                    if len(partial) > 256 * 1024:
                        raise RuntimeError('Guest serial record exceeded its size budget')
                    for line in lines:
                        prefix = b'STREAMKIT_EVIDENCE '
                        if not line.startswith(prefix):
                            continue
                        result = json.loads(base64.b64decode(line[len(prefix):].strip(), validate=True))
                        phase = result.get('phase')
                        if phase not in {'guest_ready', 'awaiting_reboot', 'lan_ready', 'completed', 'diagnostic_completed', 'failed', 'fixture_failed'}:
                            raise RuntimeError('Unexpected Win11 acceptance phase')
                        if phase in phases:
                            raise RuntimeError('Duplicate Win11 acceptance phase')
                        phases.add(phase)
                        print(f'Windows guest phase: {phase}', flush=True)
                        if phase == 'guest_ready':
                            verify_guest_clock(result, output / 'guest.json')
                            waiting_for = 'product installation'
                            deadline = time.monotonic() + 12 * 60
                        if phase == 'awaiting_reboot':
                            if not re.fullmatch(r'[0-9a-f]{64}', result.get('reboot_checkpoint_sha256', '')):
                                raise RuntimeError('Missing digest for the Windows reboot checkpoint')
                            checkpoint = result
                            (output / 'checkpoint.json').write_text(json.dumps(result, indent=2) + '\n')
                            waiting_for = 'reboot and product readiness'
                            deadline = time.monotonic() + 12 * 60
                        if phase == 'lan_ready':
                            if not lan or not checkpoint:
                                raise RuntimeError('Guest requested a NIC outside the post-reboot LAN stage')
                            verify_guest_clock(result, output / 'guest-lan-clock.json')
                            command('device_add', {'driver': 'e1000e', 'id': 'streamkitlan',
                                                   'bus': 'sklanport', 'netdev': 'fixture', 'mac': lan[0]})
                            waiting_for = 'independent LAN acceptance'
                            deadline = time.monotonic() + 10 * 60
                        if phase in {'completed', 'diagnostic_completed', 'failed', 'fixture_failed'}:
                            (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
                            if phase == 'diagnostic_completed':
                                return
                            if phase != 'completed':
                                raise RuntimeError('Windows guest reported an acceptance failure')
                            if not checkpoint or checkpoint['pre_reboot'] != result['pre_reboot']:
                                raise RuntimeError('The resumed result does not match the observed pre-reboot checkpoint')
                            if result.get('reboot_checkpoint_sha256') != checkpoint['reboot_checkpoint_sha256']:
                                raise RuntimeError('Windows resumed from different checkpoint bytes')
                            return
                time.sleep(1)
            raise TimeoutError(f'Windows guest timed out during {waiting_for}')
        except Exception:
            try:
                command('screendump', {'filename': str(output / 'guest-screen.ppm')})
            except (OSError, ValueError, RuntimeError):
                pass
            raise


if __name__ == '__main__':
    main()
