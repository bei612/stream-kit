"""Observe an owned QEMU guest through its control socket and private UART."""
import base64
import json
import os
import socket
import sys
import time
from pathlib import Path


def main():
    qmp_path, serial_path, output_path, pid, *lan = sys.argv[1:]
    if len(lan) > 1:
        raise ValueError('Expected at most one owned LAN adapter MAC address')
    serial = Path(serial_path)
    output = Path(output_path)
    deadline = time.monotonic() + (38 if lan else 32) * 60
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
                            (output / 'guest.json').write_text(json.dumps(result, indent=2) + '\n')
                        if phase == 'awaiting_reboot':
                            checkpoint = result
                            (output / 'checkpoint.json').write_text(json.dumps(result, indent=2) + '\n')
                        if phase == 'lan_ready':
                            if not lan or not checkpoint:
                                raise RuntimeError('Guest requested a NIC outside the post-reboot LAN stage')
                            command('device_add', {'driver': 'e1000e', 'id': 'streamkitlan',
                                                   'bus': 'sklanport', 'netdev': 'fixture', 'mac': lan[0]})
                        if phase in {'completed', 'diagnostic_completed', 'failed', 'fixture_failed'}:
                            (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
                            if phase == 'diagnostic_completed':
                                return
                            if phase != 'completed':
                                raise RuntimeError('Windows guest reported an acceptance failure')
                            if not checkpoint or checkpoint['pre_reboot'] != result['pre_reboot']:
                                raise RuntimeError('The resumed result does not match the observed pre-reboot checkpoint')
                            return
                time.sleep(1)
            raise TimeoutError('Windows guest did not report a final acceptance result')
        except Exception:
            try:
                command('screendump', {'filename': str(output / 'guest-screen.ppm')})
            except (OSError, ValueError, RuntimeError):
                pass
            raise


if __name__ == '__main__':
    main()
