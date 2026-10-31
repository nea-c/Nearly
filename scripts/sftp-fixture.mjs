import ssh2 from "ssh2";
const { Server, utils } = ssh2;
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { argon2id } from "@noble/hashes/argon2.js";
const sshString = (b) => {
  b = Buffer.from(b);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length);
  return Buffer.concat([len, b]);
};
const mpint = (b) => {
  b = Buffer.from(b, "base64url");
  return sshString(b[0] & 128 ? Buffer.concat([Buffer.from([0]), b]) : b);
};
const sha1 = (b) => crypto.createHash("sha1").update(b).digest();
export async function createFixture(output, {firstHandle = 1, beforeStat, beforeOpen, beforeWrite, beforeRead, beforeReadDir, beforeRmdir, beforeSetStat, mapReadDir, mapStat, mapRealpath, beforeRename, posixRename = true, advertisedOpenHandles, rejectLimits = false, responseDelayMs = 0, observeRequest, observeResponse} = {}) {
  if (!Number.isInteger(responseDelayMs) || responseDelayMs < 0 || responseDelayMs > 100) throw Error('Invalid generated response delay');
  output = path.resolve(output);
  fs.mkdirSync(output, { recursive: true });
  const remote = path.join(output, "remote");
  fs.mkdirSync(path.join(remote, "upload"), { recursive: true });
  fs.mkdirSync(path.join(remote, "other"), { recursive: true });
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = pair.privateKey.export({ format: "jwk" });
  const passphrase = "fixture-only-not-a-user-secret";
  const pub = Buffer.concat([sshString("ssh-rsa"), mpint(jwk.e), mpint(jwk.n)]);
  let priv = Buffer.concat([
    mpint(jwk.d),
    mpint(jwk.p),
    mpint(jwk.q),
    mpint(jwk.qi),
  ]);
  priv = Buffer.concat([
    priv,
    crypto.randomBytes((16 - (priv.length % 16)) % 16),
  ]);
  const key = Buffer.concat([
    sha1(Buffer.concat([Buffer.alloc(4), Buffer.from(passphrase)])),
    sha1(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(passphrase)])),
  ]).subarray(0, 32);
  const encrypted = Buffer.concat([
    crypto
      .createCipheriv("aes-256-cbc", key, Buffer.alloc(16))
      .setAutoPadding(false)
      .update(priv),
  ]);
  const macData = Buffer.concat(
    ["ssh-rsa", "aes256-cbc", "isolated-test-fixture", pub, priv].map(
      sshString,
    ),
  );
  const mac = crypto
    .createHmac("sha1", sha1("putty-private-key-file-mac-key" + passphrase))
    .update(macData)
    .digest("hex");
  const lines = (b) => b.toString("base64").match(/.{1,64}/g);
  const ppk2 = path.join(output, "fixture-v2.ppk");
  fs.writeFileSync(
    ppk2,
    [
      "PuTTY-User-Key-File-2: ssh-rsa",
      "Encryption: aes256-cbc",
      "Comment: isolated-test-fixture",
      "Public-Lines: " + lines(pub).length,
      ...lines(pub),
      "Private-Lines: " + lines(encrypted).length,
      ...lines(encrypted),
      "Private-MAC: " + mac,
      "",
    ].join("\r\n"),
  );
  const ppk3 = path.join(output, "fixture-v3.ppk");
  const salt = crypto.randomBytes(16);
  const derived = Buffer.from(
    argon2id(Buffer.from(passphrase), salt, { t: 3, m: 8192, p: 1, dkLen: 80 }),
  );
  const cipher3 = crypto
    .createCipheriv(
      "aes-256-cbc",
      derived.subarray(0, 32),
      derived.subarray(32, 48),
    )
    .setAutoPadding(false);
  const encrypted3 = Buffer.concat([cipher3.update(priv), cipher3.final()]);
  const mac3 = crypto
    .createHmac("sha256", derived.subarray(48, 80))
    .update(macData)
    .digest("hex");
  fs.writeFileSync(
    ppk3,
    [
      "PuTTY-User-Key-File-3: ssh-rsa",
      "Encryption: aes256-cbc",
      "Comment: isolated-test-fixture",
      "Public-Lines: " + lines(pub).length,
      ...lines(pub),
      "Key-Derivation: Argon2id",
      "Argon2-Memory: 8192",
      "Argon2-Passes: 3",
      "Argon2-Parallelism: 1",
      "Argon2-Salt: " + salt.toString("hex"),
      "Private-Lines: " + lines(encrypted3).length,
      ...lines(encrypted3),
      "Private-MAC: " + mac3,
      "",
    ].join("\r\n"),
  );
  derived.fill(0);
  const host = crypto
    .generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" });
  const hostPublic = utils.parseKey(host).getPublicSSH();
  const fingerprint =
    "ssh-rsa 2048 " +
    crypto
      .createHash("sha256")
      .update(hostPublic)
      .digest("base64")
      .replace(/=+$/, "");
  let available = true,
    holdAuthentication = false,
    waitingAuthentication = 0,
    authenticated = 0,
    authenticationRequests = 0,
    totalConnections = 0,
    writeRequests = 0,
    largeWrites = 0;
  const connections = new Set();
  let openFileHandles=0,maxOpenFileHandles=0;
  let openDirectoryHandles=0,maxOpenDirectoryHandles=0;
  let holdListings = false;
  const pendingListings = [];
  const requestCounts = Object.create(null);
  const requestPaths = [];
  const fileSystemErrors = [];
  const responseTimers = new Set();
  const server = new Server({ hostKeys: [host] }, (client) => {
    totalConnections++;
    const connectionNumber = totalConnections;
    if (!available) {
      client.end();
      return;
    }
    connections.add(client);
    // ssh2 1.17's server has no public API to advertise extensions. This exact
    // VERSION-frame adapter is test-only; the real client never depends on it.
    const channelData = client._protocol.channelData.bind(client._protocol);
    // Optional test-only SFTP response hold. This does not model SSH handshake,
    // bandwidth, loss or a symmetric TCP RTT. Default path preserves return value.
    const send = (channel, data) => {
      if (!responseDelayMs) { observeResponse?.(data,connectionNumber); return channelData(channel,data); }
      const packet=Buffer.from(data);
      const timer=setTimeout(()=>{responseTimers.delete(timer);if(connections.has(client)){observeResponse?.(packet,connectionNumber);channelData(channel,packet);}},responseDelayMs);
      responseTimers.add(timer);
    };
    const limitReplies=new Map();
    client._protocol.channelData = (channel, data) => {
      if (data.length>=9&&data[4]===101&&limitReplies.has(data.readUInt32BE(5))){const id=data.readUInt32BE(5),payload=limitReplies.get(id);limitReplies.delete(id);const reply=Buffer.alloc(9+payload.length);reply.writeUInt32BE(reply.length-4);reply[4]=201;reply.writeUInt32BE(id,5);payload.copy(reply,9);return send(channel,reply);}
      if ((posixRename||advertisedOpenHandles!==undefined) && data.length === 9 && data.readUInt32BE(0) === 5 && data[4] === 2) {
        const version = Buffer.concat([
          data,
          ...(posixRename?[sshString("posix-rename@openssh.com"),sshString("1")]:[]),
          ...(advertisedOpenHandles!==undefined?[sshString("limits@openssh.com"),sshString("1")]:[]),
        ]);
        version.writeUInt32BE(version.length - 4, 0);
        return send(channel, version);
      }
      return send(channel, data);
    };
    client.on("error", () => {});
    client.on("close", () => connections.delete(client));
    client.on("authentication", (ctx) => {
      authenticationRequests++;
      if (holdAuthentication) {
        waitingAuthentication++;
        return;
      }
      if (
        ctx.method === "publickey" &&
        ctx.username === "fixture" &&
        ctx.key.data.equals(pub) &&
        (!ctx.signature ||
          utils
            .parseKey("ssh-rsa " + pub.toString("base64"))
            .verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)
      ) {
        if (ctx.signature) authenticated++;
        ctx.accept();
      } else ctx.reject(["publickey"]);
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (accept) => {
          const stream = accept(),
            handles = new Map();
          for (const operation of ["STAT", "LSTAT", "REALPATH", "OPENDIR", "READDIR", "OPEN", "READ", "WRITE", "FSTAT", "CLOSE", "MKDIR", "RENAME", "REMOVE", "RMDIR", "EXTENDED", "SETSTAT", "FSETSTAT"])
            stream.on(operation, (id,p) => {
              requestCounts[operation] = (requestCounts[operation] || 0) + 1;
              observeRequest?.(operation,id,connectionNumber,p);
              if (typeof p === 'string' && requestPaths.length < 20000) requestPaths.push({operation,path:p});
            });
          let next = firstHandle;
          const OK = 0,
            EOF = 1,
            FAILURE = 4;
          const local = (p) => {
            p = p.replaceAll("\\", "/");
            const resolved = path.resolve(remote, "." + p);
            if (resolved !== remote && !resolved.startsWith(remote + path.sep))
              throw Error("outside root");
            return resolved;
          };
          const attrs = (m) => ({
            mode: m.mode,
            size: m.size,
            uid: 0,
            gid: 0,
            atime: Math.floor(m.atimeMs / 1000),
            mtime: Math.floor(m.mtimeMs / 1000),
          });
          const status = (id, e) => {
            if (e && fileSystemErrors.length < 1000)
              fileSystemErrors.push({
                at: new Date().toISOString(),
                code: e.code,
                syscall: e.syscall,
              });
            stream.status(id, e ? FAILURE : OK);
          };
          for (const op of ["STAT", "LSTAT"])
            stream.on(op, async (id, p) => {
              try {
                const status = beforeStat ? await beforeStat(op, p) : undefined;
                if (status !== undefined) { stream.status(id,status); return; }
                stream.attrs(id, mapStat ? mapStat(p,attrs(fs.lstatSync(local(p)))) : attrs(fs.lstatSync(local(p))));
              } catch {
                stream.status(id, 2);
              }
            });
          stream.on("REALPATH", (id, p) => {
            try {
              const resolved = local(p === "." ? "/" : p);
              stream.name(id, [
                {
                  filename:
                    mapRealpath?.(p,"/" + path.relative(remote, resolved).replaceAll("\\", "/")) ?? "/" + path.relative(remote, resolved).replaceAll("\\", "/"),
                  longname: "",
                  attrs: attrs(fs.statSync(resolved)),
                },
              ]);
            } catch {
              stream.status(id, 2);
            }
          });
          stream.on("OPENDIR", (id, p) => {
            const respond = () => {
              if (stream.destroyed) return;
              try {
                const h = Buffer.alloc(4);
                h.writeUInt32BE(next++);
                handles.set(h.toString("hex"), {
                  list: fs.readdirSync(local(p)),
                  p: local(p),
                });
                openDirectoryHandles++;maxOpenDirectoryHandles=Math.max(maxOpenDirectoryHandles,openDirectoryHandles);
                stream.handle(id, h);
              } catch {
                stream.status(id, 2);
              }
            };
            if (holdListings) pendingListings.push(respond);
            else respond();
          });
          stream.on("READDIR", async (id, h) => {
            const entry = handles.get(h.toString("hex"));
            const override = beforeReadDir ? await beforeReadDir(entry?.p) : undefined;
            if (override !== undefined) { stream.status(id,override); return; }
            if (!entry?.list?.length) {
              stream.status(id, EOF);
              return;
            }
            let names = entry.list.splice(0, 100).map((name) => ({
              filename: name,
              longname: name,
              attrs: attrs(fs.lstatSync(path.join(entry.p, name))),
            }));
            if (mapReadDir) names = mapReadDir(entry.p, names);
            stream.name(id, names);
          });
          stream.on("OPEN", (id, p, flags) => {
            try {
              const h = Buffer.alloc(4);
              h.writeUInt32BE(next++);
              const c = fs.constants;
              beforeOpen?.(p, flags);
              const access = flags & 2 ? (flags & 1 ? c.O_RDWR : c.O_WRONLY) : c.O_RDONLY;
              const fd = fs.openSync(local(p), access | (flags & 8 ? c.O_CREAT : 0) | (flags & 16 ? c.O_TRUNC : 0) | (flags & 32 ? c.O_EXCL : 0) | (flags & 4 ? c.O_APPEND : 0));
              handles.set(h.toString("hex"), { fd, p: local(p) });
              openFileHandles++;maxOpenFileHandles=Math.max(maxOpenFileHandles,openFileHandles);
              stream.handle(id, h);
            } catch {
              stream.status(id, FAILURE);
            }
          });
          stream.on("WRITE", async (id, h, offset, data) => {
            writeRequests++;
            const entry=handles.get(h.toString("hex"));
            const target=entry?.p ? '/'+path.relative(remote,entry.p).split(path.sep).join('/') : '';
            const injected=await beforeWrite?.(target,offset,data);
            if(stream.destroyed||handles.get(h.toString("hex"))!==entry)return;
            if (typeof injected==='number') {stream.status(id,injected);return;}
            try {
              fs.writeSync(
                handles.get(h.toString("hex")).fd,
                data,
                0,
                data.length,
                offset,
              );
              if (data.length >= 32768) {
                largeWrites++;
                setTimeout(() => {
                  if (!stream.destroyed)
                    try {
                      status(id);
                    } catch {}
                }, 200);
              } else status(id);
            } catch (e) {
              status(id, e);
            }
          });
          stream.on("READ", async (id, h, offset, length) => {
            const entry=handles.get(h.toString("hex"));
            const source=entry?.p ? '/'+path.relative(remote,entry.p).split(path.sep).join('/') : '';
            if(beforeRead){const injected=await beforeRead(source,offset,length);if(typeof injected==='number'){stream.status(id,injected);return;}}
            try {
              const buffer = Buffer.alloc(Math.min(length, 65536));
              const count = fs.readSync(handles.get(h.toString("hex")).fd, buffer, 0, buffer.length, offset);
              if (count) stream.data(id, buffer.subarray(0, count));
              else stream.status(id, EOF);
            } catch (e) { status(id, e); }
          });
          stream.on("FSTAT", (id, h) => {
            try {
              stream.attrs(
                id,
                attrs(fs.fstatSync(handles.get(h.toString("hex")).fd)),
              );
            } catch {
              stream.status(id, FAILURE);
            }
          });
          stream.on("CLOSE", (id, h) => {
            try {
              const e = handles.get(h.toString("hex"));
              if (e?.fd !== undefined) {fs.closeSync(e.fd);openFileHandles--;}
              if (e?.list !== undefined) openDirectoryHandles--;
              handles.delete(h.toString("hex"));
              status(id);
            } catch (e) {
              status(id, e);
            }
          });
          stream.on("MKDIR", (id, p) => {
            try {
              fs.mkdirSync(local(p));
              status(id);
            } catch (e) {
              status(id, e);
            }
          });
          stream.on("RENAME", (id, a, b) => {
            try {
              beforeRename?.(a,b,false);
              if (fs.existsSync(local(b))) throw Object.assign(Error("destination exists"), {code:"EEXIST"});
              fs.renameSync(local(a), local(b));
              status(id);
            } catch (e) {
              status(id, e);
            }
          });
          stream.on("REMOVE", (id, p) => {
            try { fs.unlinkSync(local(p)); status(id); } catch(e) { status(id,e); }
          });
          stream.on("RMDIR", async (id, p) => {
            const override=beforeRmdir ? await beforeRmdir(p,local(p)) : undefined;
            if (override !== undefined) {stream.status(id,override);return;}
            try { fs.rmdirSync(local(p)); status(id); } catch(e) { status(id,e); }
          });
          for (const op of ["SETSTAT", "FSETSTAT"]) stream.on(op, async (id, target, a) => {
            try {
              const entry = op === "FSETSTAT" ? handles.get(target.toString("hex")) : undefined;
              const filename = entry?.p ?? local(target);
              const override = beforeSetStat ? await beforeSetStat(op, filename, a) : undefined;
              if (override !== undefined) { stream.status(id, override); return; }
              if (!Number.isInteger(a.atime) || !Number.isInteger(a.mtime)) throw Error("paired timestamps required");
              if (entry) fs.futimesSync(entry.fd, a.atime, a.mtime);
              else fs.utimesSync(filename, a.atime, a.mtime);
              status(id);
            } catch (e) { status(id, e); }
          });
          stream.on("EXTENDED", (id, request, data) => {
            if(request==='limits@openssh.com'&&advertisedOpenHandles!==undefined){if(rejectLimits)return stream.status(id,8);const payload=Buffer.alloc(32);[1048576,32768,32768,advertisedOpenHandles].forEach((n,i)=>payload.writeBigUInt64BE(BigInt(n),i*8));limitReplies.set(id,payload);return stream.status(id,0);}
            if (request !== "posix-rename@openssh.com")
              return stream.status(id, 8);
            try {
              let offset = 0;
              const read = () => {
                const n = data.readUInt32BE(offset);
                offset += 4;
                const result = data
                  .subarray(offset, offset + n)
                  .toString("utf8");
                offset += n;
                return result;
              };
              const source = read(),
                target = read();
              if (offset !== data.length)
                throw Error("Malformed extension payload");
              beforeRename?.(source,target,true);
              fs.renameSync(local(source), local(target));
              status(id);
            } catch (e) {
              status(id, e);
            }
          });
          stream.on("close", () => {
            for (const e of handles.values())if(e.fd!==undefined){try{fs.closeSync(e.fd);}catch{}openFileHandles--;}
            for (const e of handles.values())if(e.list!==undefined)openDirectoryHandles--;
            handles.clear();
          });
        });
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    remote,
    ppk2,
    ppk3,
    passphrase,
    fingerprint,
    fileSystemErrors,
    port,
    get authenticated() {
      return authenticated;
    },
    get authenticationRequests() {
      return authenticationRequests;
    },
    get totalConnections() {
      return totalConnections;
    },
    get writeRequests() {
      return writeRequests;
    },
    get requestCounts() {
      return { ...requestCounts };
    },
    get openFileHandles(){return openFileHandles;},
    get maxOpenFileHandles(){return maxOpenFileHandles;},
    get openDirectoryHandles(){return openDirectoryHandles;},
    get maxOpenDirectoryHandles(){return maxOpenDirectoryHandles;},
    get requestPaths() { return requestPaths.map(entry=>({...entry})); },
    get connectionCount() {
      return connections.size;
    },
    get largeWrites() {
      return largeWrites;
    },
    disconnect() {
      available = false;
      for (const c of connections) c.end();
    },
    resume() {
      available = true;
      holdAuthentication = false;
    },
    stallReconnect() {
      available = true;
      holdAuthentication = true;
    },
    get waitingAuthentication() {
      return waitingAuthentication;
    },
    holdListings() {
      holdListings = true;
    },
    get waitingListings() {
      return pendingListings.length;
    },
    releaseListings() {
      holdListings = false;
      for (const respond of pendingListings.splice(0)) respond();
    },
    async close() {
      for (const timer of responseTimers) clearTimeout(timer);
      responseTimers.clear();
      pendingListings.length = 0;
      for (const c of connections) c.end();
      await new Promise((r) => server.close(r));
    },
  };
}
