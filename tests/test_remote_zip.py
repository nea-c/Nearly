"""Isolated Python stdlib tests; run on Linux: python3 tests/test_remote_zip.py."""
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
import zipfile

HELPER = Path(__file__).resolve().parents[1] / 'src-tauri/src/remote_zip.py'

@unittest.skipUnless(sys.platform.startswith('linux'), 'requires Linux fd and renameat2 semantics')
class RemoteZipTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def start(self, action, sources, destination, before_confirm=None):
        request = dict(action=action, sources=list(map(str, sources)), destination=str(destination))
        payload = base64.b64encode(json.dumps(request).encode()).decode()
        code = 'NEARLY_REQUEST = ' + repr(payload) + '\n' + HELPER.read_text()
        bootstrap = 'import sys;exec(compile(sys.stdin.buffer.read(%d),"nearly-remote-zip","exec"))' % len(code.encode())
        p = subprocess.Popen([sys.executable, '-u', '-c', bootstrap], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        p.stdin.write(code.encode()); p.stdin.flush()
        line = p.stdout.readline()
        message = json.loads(line[len(b'NEARLY_ZIP '):])
        if message['type'] == 'namespace':
            self.assertEqual(Path(message['path']).read_text(), message['token'])
            if before_confirm:
                before_confirm()
            p.stdin.write(b'NEARLY_CONFIRM\n'); p.stdin.flush()
        else:
            p.first_message = line
        p.stdin.close(); p.stdin = None
        return p

    def run_job(self, action, sources, destination, code=None):
        p = self.start(action, sources, destination)
        out, err = p.communicate(timeout=20)
        out = getattr(p, "first_message", b"") + out
        self.assertEqual(err, b'')
        messages = [json.loads(line[len('NEARLY_ZIP '):]) for line in out.decode().splitlines()]
        self.assertTrue(messages)
        result = messages[-1]
        if code:
            self.assertNotEqual(p.returncode, 0)
            self.assertEqual(result['code'], code)
        else:
            self.assertEqual(p.returncode, 0, result)
            self.assertEqual(result['type'], 'result')
        self.assertFalse(list(self.root.glob('.nearly-zip-*')))
        return result

    def test_roundtrip_unusual_names_and_progress(self):
        source = self.root / "-quote' $(echo x);\u65e5\u672c\u8a9e"
        source.mkdir(); (source / 'file.txt').write_bytes(b'hello' * 50000)
        (source / 'empty').mkdir()
        archive = self.root / 'archive.zip'
        result = self.run_job('compress', [source], archive)
        self.assertEqual(result['bytes'], 250000)
        self.run_job('extract', [archive], self.root / 'out')
        self.assertEqual((self.root / 'out' / source.name / 'file.txt').read_bytes(), b'hello' * 50000)

    def test_existing_destination_untouched(self):
        source = self.root / 'source'; source.write_bytes(b'a')
        dest = self.root / 'dest'; dest.write_bytes(b'KEEP')
        self.run_job('compress', [source], dest, 'collision')
        self.assertEqual(dest.read_bytes(), b'KEEP')

    def test_unsafe_members(self):
        for i, names in enumerate([['../escape'], ['/absolute'], ['A', 'a'], ['a', 'a/b'], ['a/b', 'A/c'], ['x\\y'], ['CON']]):
            z = self.root / ('bad%d.zip' % i)
            with zipfile.ZipFile(z, 'w') as archive:
                for name in names: archive.writestr(name, b'x')
            self.run_job('extract', [z], self.root / ('out%d' % i), 'unsafe_entry')

    def test_source_symlink_and_ancestor(self):
        real = self.root / 'real'; real.mkdir(); (real / 'x').write_bytes(b'x')
        link = self.root / 'link'; link.symlink_to(real, target_is_directory=True)
        self.run_job('compress', [link], self.root / 'a.zip', 'unsafe_entry')
        self.run_job('compress', [link / 'x'], link / 'b.zip', 'unsafe_entry')
        self.run_job('compress', [real], real / 'a.zip', 'invalid_request')

    def test_archive_symlink(self):
        z = self.root / 'bad.zip'
        with zipfile.ZipFile(z, 'w') as archive:
            info = zipfile.ZipInfo('link'); info.create_system = 3; info.external_attr = 0o120777 << 16
            archive.writestr(info, 'elsewhere')
        self.run_job('extract', [z], self.root / 'out', 'unsafe_entry')

    def test_cancel_cleans_stage(self):
        source = self.root / 'big'
        with source.open('wb') as f: f.truncate(256 * 1024 * 1024)
        p = self.start('compress', [source], self.root / 'cancel.zip')
        first = p.stdout.readline()
        self.assertTrue(first.startswith(b'NEARLY_ZIP '))
        p.send_signal(signal.SIGTERM)
        out, err = p.communicate(timeout=20)
        self.assertEqual(err, b'')
        self.assertIn(b'cancelled', out)
        self.assertFalse((self.root / 'cancel.zip').exists())
        self.assertFalse(list(self.root.glob('.nearly-zip-*')))


    def test_destination_created_after_preflight_is_not_replaced(self):
        source = self.root / 'source'; source.write_bytes(b'x')
        destination = self.root / 'race.zip'
        p = self.start('compress', [source], destination, lambda: destination.write_bytes(b'KEEP'))
        out, err = p.communicate(timeout=20)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b'collision', out)
        self.assertEqual(destination.read_bytes(), b'KEEP')
        self.assertFalse(list(self.root.glob('.nearly-zip-*')))

    def test_encrypted_flag_rejected(self):
        z = self.root / 'encrypted.zip'
        with zipfile.ZipFile(z, 'w') as archive: archive.writestr('x', b'x')
        data = bytearray(z.read_bytes())
        central = data.index(b'PK\x01\x02')
        data[central + 8] |= 1
        z.write_bytes(data)
        self.run_job('extract', [z], self.root / 'out', 'unsafe_entry')

    def test_sibling_parent_mismatch_rejected(self):
        folder = self.root / 'nested'; folder.mkdir()
        source = folder / 'source'; source.write_bytes(b'x')
        self.run_job('compress', [source], self.root / 'out.zip', 'invalid_request')

    def test_selected_limit(self):
        self.run_job('compress', [self.root / ('file%d' % i) for i in range(501)], self.root / 'out.zip', 'invalid_request')

    def test_parent_swap_does_not_redirect_source_read(self):
        parent = self.root / 'parent'; parent.mkdir()
        moved = self.root / 'original'
        source = parent / 'source'; source.write_bytes(b'ORIGINAL')
        def swap():
            parent.rename(moved)
            parent.mkdir()
            # A symlink here would yield unsafe_entry if the helper re-resolved it.
            (parent / 'source').symlink_to(self.root / 'missing')
        p = self.start('compress', [source], parent / 'out.zip', swap)
        out, err = p.communicate(timeout=20)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b'source_changed', out)
        self.assertEqual((moved / 'source').read_bytes(), b'ORIGINAL')
        self.assertTrue((parent / 'source').is_symlink())
        self.assertFalse(list(moved.glob('.nearly-zip-*')))
        self.assertFalse((parent / 'out.zip').exists())

    def test_extract_parent_swap_uses_retained_directory(self):
        parent = self.root / 'parent'; parent.mkdir()
        moved = self.root / 'original'
        source = parent / 'source.zip'
        with zipfile.ZipFile(source, 'w') as archive: archive.writestr('x', b'ORIGINAL')
        def swap():
            parent.rename(moved)
            parent.mkdir()
            (parent / 'source.zip').write_bytes(b'NOT A ZIP')
        p = self.start('extract', [source], parent / 'out', swap)
        out, err = p.communicate(timeout=20)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b'source_changed', out)
        self.assertEqual((parent / 'source.zip').read_bytes(), b'NOT A ZIP')
        self.assertFalse(list(moved.glob('.nearly-zip-*')))

    def test_substituted_stage_is_not_cleaned(self):
        source = self.root / 'source'; source.write_bytes(b'x')
        moved = self.root / 'original-stage'
        def swap():
            stage = next(self.root.glob('.nearly-zip-*'))
            stage.rename(moved)
            stage.mkdir()
            (stage / 'KEEP').write_bytes(b'KEEP')
        p = self.start('compress', [source], self.root / 'out.zip', swap)
        out, err = p.communicate(timeout=20)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b'source_changed', out)
        stage = next(self.root.glob('.nearly-zip-*'))
        self.assertEqual((stage / 'KEEP').read_bytes(), b'KEEP')
        self.assertIn(b'stagePath', out)

    def test_mkdir_substitution_preserves_unknown_tree(self):
        source = self.root / 'source'; source.write_bytes(b'x')
        donor = self.root / 'donor'; donor.mkdir()
        (donor / 'KEEP').write_bytes(b'KEEP')
        request = dict(action='compress', sources=[str(source)], destination=str(self.root / 'out.zip'))
        payload = base64.b64encode(json.dumps(request).encode()).decode()
        # Inject only the filesystem race at the mkdir boundary, not worker logic.
        setup = """
import importlib.util
spec = importlib.util.spec_from_file_location("worker", HELPER_PATH)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.NEARLY_REQUEST = PAYLOAD
original_mkdir = worker.os.mkdir
def race(path, mode=0o777, *, dir_fd=None):
    original_mkdir(path, mode, dir_fd=dir_fd)
    if str(path).startswith(".nearly-zip-"):
        worker.os.rmdir(path, dir_fd=dir_fd)
        worker.os.rename(DONOR, path, dst_dir_fd=dir_fd)
worker.os.mkdir = race
raise SystemExit(worker.main())
"""
        setup = setup.replace('HELPER_PATH', repr(str(HELPER))).replace('PAYLOAD', repr(payload)).replace('DONOR', repr(str(donor)))
        p = subprocess.run([sys.executable, '-c', setup], capture_output=True, timeout=20)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b'source_changed', p.stdout)
        self.assertIn(b'stagePath', p.stdout)
        stage = next(self.root.glob('.nearly-zip-*'))
        self.assertEqual((stage / 'KEEP').read_bytes(), b'KEEP')

    def test_cleanup_preserves_unowned_stage_entry(self):
        source = self.root / 'large'
        with source.open('wb') as stream: stream.truncate(513 * 1024 * 1024)
        def insert_unknown():
            stage = next(self.root.glob('.nearly-zip-*'))
            (stage / 'KEEP').write_bytes(b'KEEP')
        p = self.start('compress', [source], self.root / 'out.zip', insert_unknown)
        out, err = p.communicate(timeout=20)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b'limit_exceeded', out)
        self.assertIn(b'stagePath', out)
        stage = next(self.root.glob('.nearly-zip-*'))
        self.assertEqual((stage / 'KEEP').read_bytes(), b'KEEP')

    def test_corrupt_crc(self):
        z = self.root / 'corrupt.zip'
        with zipfile.ZipFile(z, 'w') as archive: archive.writestr('x', b'known payload')
        data = z.read_bytes().replace(b'known payload', b'WRONG payload')
        z.write_bytes(data)
        self.run_job('extract', [z], self.root / 'out', 'integrity_error')

    def test_unsupported_compression(self):
        z = self.root / 'bzip.zip'
        with zipfile.ZipFile(z, 'w', compression=zipfile.ZIP_BZIP2) as archive: archive.writestr('x', b'x')
        self.run_job('extract', [z], self.root / 'out', 'unsupported_zip')

    def test_destination_symlink_ancestor(self):
        real = self.root / 'real'; real.mkdir()
        link = self.root / 'link'; link.symlink_to(real, target_is_directory=True)
        source = self.root / 'source'; source.write_bytes(b'x')
        self.run_job('compress', [link / 'source'], link / 'out.zip', 'unsafe_entry')
        self.assertEqual(list(real.iterdir()), [])

    def test_oversized_source(self):
        source = self.root / 'large'
        with source.open('wb') as f: f.truncate(513 * 1024 * 1024)
        self.run_job('compress', [source], self.root / 'out.zip', 'limit_exceeded')

    def test_missing_namespace_confirmation(self):
        source = self.root / 'source'; source.write_bytes(b'x')
        request = dict(action='compress', sources=[str(source)], destination=str(self.root / 'out.zip'))
        payload = base64.b64encode(json.dumps(request).encode()).decode()
        code = 'NEARLY_REQUEST = ' + repr(payload) + '\n' + HELPER.read_text()
        bootstrap = 'import sys;exec(compile(sys.stdin.buffer.read(%d),"nearly-remote-zip","exec"))' % len(code.encode())
        p = subprocess.run([sys.executable, '-u', '-c', bootstrap], input=code.encode(), capture_output=True, timeout=20)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(b'remote_path_mismatch', p.stdout)
        self.assertFalse(list(self.root.glob('.nearly-zip-*')))
        self.assertFalse((self.root / 'out.zip').exists())

if __name__ == '__main__': unittest.main()
