"""Nearly's stdin-only remote ZIP worker. No user path is evaluated as code.
Linux only: refuse rather than degrade atomic no-replace or no-follow guarantees.
A caller prepends NEARLY_REQUEST (base64 JSON), reads exactly that script length
via a fixed Python bootstrap, and keeps stdin open for namespace confirmation.
"""
import base64
import ctypes
import errno
import json
import os
import secrets
import select
import signal
import stat
import struct
import sys
import time
import zipfile

MAX_SELECTED = 500
# Hard limits: 500 selected siblings, 10k entries including implicit parents,
# depth 40, 512 MiB archive/member, 2 GiB expanded, 16 MiB central directory,
# 300 seconds operation and 15 seconds namespace confirmation. ZIP64 is refused.
MAX_ENTRIES = 10000
MAX_DEPTH = 40
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_SINGLE = 512 * 1024 * 1024
MAX_TOTAL = 2 * 1024 * 1024 * 1024
MAX_CENTRAL = 16 * 1024 * 1024
CHUNK = 128 * 1024


class Failure(Exception):
    pass


def fail(code):
    raise Failure(code)


def emit(kind, **values):
    print("NEARLY_ZIP " + json.dumps(dict(type=kind, **values), ensure_ascii=True), flush=True)


class Budget:
    def __init__(self):
        self.deadline = time.monotonic() + 300
        self.entries = 0
        self.bytes = 0
        self.last = 0
        self.cancelled = False

    def check(self):
        if self.cancelled:
            fail("cancelled")
        if time.monotonic() > self.deadline:
            fail("limit_exceeded")

    def progress(self):
        self.check()
        now = time.monotonic()
        if now - self.last >= 0.25:
            emit("progress", entries=self.entries, bytes=self.bytes)
            self.last = now

    def chunk(self, amount):
        self.bytes += amount
        if self.bytes > MAX_TOTAL:
            fail("limit_exceeded")
        self.progress()


def components(path):
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or len(path.encode("utf-8")) > 4096:
        fail("invalid_request")
    parts = path[1:].split("/")
    if any(p in ("", ".", "..") or "\x00" in p for p in parts):
        fail("invalid_request")
    return parts


def directory(parts, root=None, create=False, owned=None, prefix=()):
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY) if root is None else os.dup(root)
    try:
        for index, part in enumerate(parts):
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    if owned is not None:
                        owned[prefix + tuple(parts[:index + 1])] = os.stat(part, dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    if owned is not None:
                        expected = owned.get(prefix + tuple(parts[:index + 1]))
                        if expected is None or not same_object(expected, os.stat(part, dir_fd=fd, follow_symlinks=False)):
                            fail("source_changed")
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        return fd
    except BaseException:
        os.close(fd)
        raise


def fingerprint(st):
    return (st.st_dev, st.st_ino, st.st_mode, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def regular(parent, name):
    before = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode):
        fail("unsafe_entry")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    after = os.fstat(fd)
    if fingerprint(before) != fingerprint(after):
        os.close(fd)
        fail("source_changed")
    return fd, after


def safe_name(name, is_dir):
    if not isinstance(name, str) or not name or len(name.encode("utf-8")) > 1024:
        fail("unsafe_entry")
    clean = name[:-1] if is_dir and name.endswith("/") else name
    parts = clean.split("/")
    if len(parts) > MAX_DEPTH:
        fail("limit_exceeded")
    for part in parts:
        stem = part.split(".")[0].upper()
        if (not part or part in (".", "..") or part.endswith((".", " "))
                or len(part.encode("utf-16-le")) // 2 > 255
                or stem in ("CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$")
                or (len(stem) == 4 and stem[:3] in ("COM", "LPT") and stem[3] in "0123456789")
                or any(ord(c) < 32 or ord(c) == 127 or c in '\\:<>"|?*' for c in part)):
            fail("unsafe_entry")
    return parts


class Names:
    def __init__(self):
        self.names = {}
        self.count = 0

    def add(self, name, is_dir):
        parts = safe_name(name, is_dir)
        self.count += 1
        if self.count > MAX_ENTRIES:
            fail("limit_exceeded")
        for i in range(len(parts)):
            exact = "/".join(parts[:i + 1])
            key = exact.casefold()
            final = i == len(parts) - 1
            need_dir = not final or is_dir
            if key in self.names:
                old_exact, old_dir, explicit = self.names[key]
                if old_exact != exact or not old_dir or not need_dir or (final and explicit):
                    fail("unsafe_entry")
                self.names[key] = (exact, True, explicit or final)
            else:
                self.names[key] = (exact, need_dir, final)
            if len(self.names) > MAX_ENTRIES:
                fail("limit_exceeded")
        return parts


def preflight(raw, budget):
    # Bound ZipFile's central-directory allocation before constructing it.
    size = os.fstat(raw.fileno()).st_size
    if size > MAX_ARCHIVE:
        fail("limit_exceeded")
    raw.seek(max(0, size - 65557))
    tail = raw.read(65557)
    pos = tail.rfind(b"PK\x05\x06")
    if pos < 0 or len(tail) - pos < 22:
        fail("unsupported_zip")
    disk, start_disk, disk_count, count, central_size, central_offset, comment = struct.unpack_from("<4H2LH", tail, pos + 4)
    if len(tail) - pos != 22 + comment or disk or start_disk or disk_count != count:
        fail("unsupported_zip")
    if count == 65535 or central_size == 0xffffffff or central_offset == 0xffffffff:
        fail("unsupported_zip")
    if count > MAX_ENTRIES or central_size > MAX_CENTRAL:
        fail("limit_exceeded")
    eocd = size - len(tail) + pos
    if central_offset + central_size != eocd:
        fail("unsupported_zip")
    raw.seek(0)
    archive = zipfile.ZipFile(raw)
    try:
        if len(archive.infolist()) != count:
            fail("unsupported_zip")
        names = Names()
        total = 0
        for info in archive.infolist():
            budget.check()
            # Reject NUL truncation, encrypted files, special files, ZIP64 and unsupported codecs.
            if info.orig_filename != info.filename or info.flag_bits & 1:
                fail("unsafe_entry")
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                fail("unsupported_zip")
            kind = stat.S_IFMT(info.external_attr >> 16)
            is_dir = info.is_dir()
            if kind not in (0, stat.S_IFDIR if is_dir else stat.S_IFREG):
                fail("unsafe_entry")
            if not (info.flag_bits & 0x800) and not info.filename.isascii():
                fail("unsafe_entry")
            names.add(info.filename, is_dir)
            total += info.file_size
            if info.file_size > MAX_SINGLE or total > MAX_TOTAL:
                fail("limit_exceeded")
            if is_dir and info.file_size:
                fail("unsupported_zip")
            if info.header_offset < 0 or info.header_offset >= central_offset:
                fail("unsupported_zip")
        return archive
    except BaseException:
        archive.close()
        raise


def compress(sources, parent, output, budget):
    names = Names()
    planned = 0

    def walk(parent, leaf, arcname, archive):
        nonlocal planned
        budget.check()
        st = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        is_dir = stat.S_ISDIR(st.st_mode)
        if not is_dir and not stat.S_ISREG(st.st_mode):
            fail("unsafe_entry")
        names.add(arcname + ("/" if is_dir else ""), is_dir)
        if is_dir:
            fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=parent)
            try:
                if fingerprint(os.fstat(fd)) != fingerprint(st):
                    fail("source_changed")
                archive.writestr(arcname + "/", b"")
                # scandir streams a directory instead of allocating an unbounded list.
                with os.scandir(fd) as children:
                    for child in children:
                        walk(fd, child.name, arcname + "/" + child.name, archive)
                if fingerprint(os.fstat(fd)) != fingerprint(st):
                    fail("source_changed")
            finally:
                os.close(fd)
        else:
            if st.st_size > MAX_SINGLE:
                fail("limit_exceeded")
            planned += st.st_size
            if planned > MAX_TOTAL:
                fail("limit_exceeded")
            fd, opened = regular(parent, leaf)
            if fingerprint(opened) != fingerprint(st):
                os.close(fd)
                fail("source_changed")
            with os.fdopen(fd, "rb") as src, archive.open(arcname, "w") as dst:
                actual = 0
                while True:
                    budget.check()
                    data = src.read(CHUNK)
                    if not data:
                        break
                    actual += len(data)
                    if actual > st.st_size:
                        fail("source_changed")
                    dst.write(data)
                    budget.chunk(len(data))
                    if output.tell() > MAX_ARCHIVE:
                        fail("limit_exceeded")
                if actual != st.st_size or fingerprint(os.fstat(src.fileno())) != fingerprint(st):
                    fail("source_changed")
        if fingerprint(os.stat(leaf, dir_fd=parent, follow_symlinks=False)) != fingerprint(st):
            fail("source_changed")
        budget.entries += 1
        budget.progress()

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=False) as archive:
        for source in sources:
            leaf = components(source)[-1]
            walk(parent, leaf, leaf, archive)
    if output.tell() > MAX_ARCHIVE:
        fail("limit_exceeded")


def extract(source, parent, root, budget, owned):
    parts = components(source)
    parent = os.dup(parent)
    try:
        fd, before = regular(parent, parts[-1])
        with os.fdopen(fd, "rb") as raw:
            with preflight(raw, budget) as archive:
                for info in archive.infolist():
                    budget.check()
                    parts_out = safe_name(info.filename, info.is_dir())
                    target_parent = directory(parts_out if info.is_dir() else parts_out[:-1], root, create=True, owned=owned, prefix=("output",))
                    try:
                        if not info.is_dir():
                            target = os.open(parts_out[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target_parent)
                            owned[("output",) + tuple(parts_out)] = os.fstat(target)
                            with os.fdopen(target, "wb") as dst, archive.open(info, "r") as src:
                                actual = 0
                                while True:
                                    budget.check()
                                    data = src.read(CHUNK)
                                    if not data:
                                        break
                                    actual += len(data)
                                    if actual > info.file_size or actual > MAX_SINGLE:
                                        fail("limit_exceeded")
                                    dst.write(data)
                                    budget.chunk(len(data))
                                if actual != info.file_size:
                                    fail("integrity_error")
                                dst.flush()
                                os.fsync(dst.fileno())
                        budget.entries += 1
                        budget.progress()
                    finally:
                        os.close(target_parent)
            if fingerprint(os.fstat(raw.fileno())) != fingerprint(before):
                fail("source_changed")
        if fingerprint(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)) != fingerprint(before):
            fail("source_changed")
    finally:
        os.close(parent)


def same_object(a, b):
    return (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino)


def clean_contents(fd, remaining, owned, prefix=(), depth=0):
    # Start from the held owned stage fd, never reopen it by its pathname.
    # Each opened child must match the no-follow stat taken before opening.
    if depth > MAX_DEPTH + 1:
        fail("limit_exceeded")
    with os.scandir(fd) as children:
        for child in children:
            remaining[0] -= 1
            if remaining[0] < 0:
                fail("limit_exceeded")
            before = os.stat(child.name, dir_fd=fd, follow_symlinks=False)
            key = prefix + (child.name,)
            expected = owned.get(key)
            if expected is None or not same_object(expected, before):
                fail("source_changed")
            if stat.S_ISDIR(before.st_mode):
                nested = os.open(child.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    if not same_object(before, os.fstat(nested)):
                        fail("source_changed")
                    clean_contents(nested, remaining, owned, key, depth + 1)
                    if not same_object(before, os.stat(child.name, dir_fd=fd, follow_symlinks=False)):
                        fail("source_changed")
                    os.rmdir(child.name, dir_fd=fd)
                finally:
                    os.close(nested)
            else:
                os.unlink(child.name, dir_fd=fd)


def publisher():
    if not sys.platform.startswith("linux"):
        fail("publish_refused")
    library = ctypes.CDLL(None, use_errno=True)
    rename = getattr(library, "renameat2", None)
    if rename is None:
        fail("publish_refused")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    return rename


def main():
    budget = Budget()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, lambda *_: setattr(budget, "cancelled", True))
    parent = None
    stage_fd = None
    stage = None
    stage_identity = None
    owned = {}
    committed = False
    destination = None
    try:
        try:
            encoded = globals().get("NEARLY_REQUEST", "")
            if not isinstance(encoded, str) or len(encoded) > 256 * 1024:
                fail("invalid_request")
            request = json.loads(base64.b64decode(encoded, validate=True).decode("utf-8"))
            action, sources, destination = request["action"], request["sources"], request["destination"]
            if action not in ("compress", "extract") or not isinstance(sources, list) or not 1 <= len(sources) <= MAX_SELECTED:
                fail("invalid_request")
            if action == "extract" and len(sources) != 1:
                fail("invalid_request")
            dest_parts = components(destination)
            for source in sources:
                if components(source)[:-1] != dest_parts[:-1]:
                    fail("invalid_request")
                if destination == source or destination.startswith(source + "/") or source.startswith(destination + "/"):
                    fail("invalid_request")
        except (KeyError, TypeError, ValueError, UnicodeError):
            fail("invalid_request")
        rename = publisher()
        parent = directory(dest_parts[:-1])
        try:
            os.stat(dest_parts[-1], dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            fail("collision")
        candidate = ".nearly-zip-" + secrets.token_hex(16)
        os.mkdir(candidate, 0o700, dir_fd=parent)
        stage = candidate
        stage_identity = os.stat(stage, dir_fd=parent, follow_symlinks=False)
        stage_fd = directory([stage], parent)
        if not same_object(stage_identity, os.fstat(stage_fd)):
            fail("source_changed")
        # mkdir cannot return an inode: reject any pre-populated substitute
        # before writing, and never delete entries absent from our creation log.
        with os.scandir(stage_fd) as initial:
            if next(initial, None) is not None:
                fail("source_changed")
        token = secrets.token_hex(32)
        marker = os.open("namespace", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage_fd)
        owned[("namespace",)] = os.fstat(marker)
        with os.fdopen(marker, "w") as stream:
            stream.write(token)
        stage_path = destination.rsplit("/", 1)[0] + "/" + stage
        emit("namespace", path=stage_path + "/namespace", token=token, stagePath=stage_path)
        until = time.monotonic() + 15
        reply = b""
        while b"\n" not in reply:
            budget.check()
            if time.monotonic() >= until:
                fail("remote_path_mismatch")
            if select.select([sys.stdin.fileno()], [], [], 0.1)[0]:
                part = os.read(sys.stdin.fileno(), 32)
                if not part:
                    fail("remote_path_mismatch")
                reply += part
                if len(reply) > 16:
                    fail("remote_path_mismatch")
        if reply != b"NEARLY_CONFIRM\n":
            fail("remote_path_mismatch")
        os.unlink("namespace", dir_fd=stage_fd)
        budget.progress()
        if action == "compress":
            fd = os.open("output", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage_fd)
            owned[("output",)] = os.fstat(fd)
            with os.fdopen(fd, "w+b") as output:
                compress(sources, parent, output, budget)
                output.flush()
                os.fsync(output.fileno())
        else:
            os.mkdir("output", 0o700, dir_fd=stage_fd)
            owned[("output",)] = os.stat("output", dir_fd=stage_fd, follow_symlinks=False)
            root = directory(["output"], stage_fd)
            try:
                extract(sources[0], parent, root, budget, owned)
                os.fsync(root)
            finally:
                os.close(root)
        budget.check()
        current_stage = os.stat(stage, dir_fd=parent, follow_symlinks=False)
        if (current_stage.st_dev, current_stage.st_ino) != (stage_identity.st_dev, stage_identity.st_ino):
            fail("source_changed")
        # Recheck the parent path still resolves to the held directory.
        verify = directory(dest_parts[:-1])
        try:
            a, b = os.fstat(parent), os.fstat(verify)
            if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                fail("source_changed")
        finally:
            os.close(verify)
        # Cancellation is blocked only for the atomic publish/result interval.
        signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGHUP})
        budget.check()
        if rename(stage_fd, b"output", parent, os.fsencode(dest_parts[-1]), 1) != 0:
            error = ctypes.get_errno()
            fail("collision" if error in (errno.EEXIST, errno.ENOTEMPTY) else "publish_refused")
        committed = True
        os.close(stage_fd)
        stage_fd = None
        os.rmdir(stage, dir_fd=parent)
        stage = None
        emit("result", entries=budget.entries, bytes=budget.bytes)
        return 0
    except BaseException as error:
        code = str(error) if isinstance(error, Failure) else "io_error"
        if isinstance(error, zipfile.BadZipFile):
            code = "integrity_error"
        elif isinstance(error, (zipfile.LargeZipFile, OverflowError)):
            code = "limit_exceeded"
        elif isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR):
            code = "unsafe_entry"
        elif isinstance(error, FileExistsError):
            code = "collision"
        residual = None
        if stage is not None and parent is not None:
            try:
                current_stage = os.stat(stage, dir_fd=parent, follow_symlinks=False)
                if stage_identity is None or (current_stage.st_dev, current_stage.st_ino) != (stage_identity.st_dev, stage_identity.st_ino):
                    fail("source_changed")
                if stage_fd is not None:
                    clean_contents(stage_fd, [MAX_ENTRIES + 2], owned)
                # If opening the newly created stage failed, attempt only an
                # empty-directory removal. Never recursively adopt an unknown tree.
                if not same_object(stage_identity, os.stat(stage, dir_fd=parent, follow_symlinks=False)):
                    fail("source_changed")
                os.rmdir(stage, dir_fd=parent)
            except FileNotFoundError:
                pass
            except BaseException:
                residual = destination.rsplit("/", 1)[0] + "/" + stage
        payload = dict(code=code, committed=committed)
        if residual is not None:
            payload["stagePath"] = residual
        try:
            emit("error", **payload)
        except (BrokenPipeError, OSError):
            pass
        return 1
    finally:
        if stage_fd is not None:
            os.close(stage_fd)
        if parent is not None:
            os.close(parent)


if __name__ == "__main__":
    sys.exit(main())
