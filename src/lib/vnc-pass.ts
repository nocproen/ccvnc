import { execFile } from "child_process";
import fsp from "fs/promises";

// 写 tigervncserver 的密码文件 ~/.vnc/passwd（VNC 密码 ≤8 字节，8 字节 DES 密文）。
// 优先级：系统 vncpasswd -f（TigerVNC 自带，最权威）→ openssl CLI（legacy provider 的 DES-ECB）。
// 不用 Node crypto DES：Node ≥17 在 OpenSSL 3 下默认禁用 DES，运行时必须 --openssl-legacy-provider，不现实。

const VNC_KEY = Buffer.from([0x2a, 0x79, 0x6a, 0x6c, 0x65, 0x79, 0x65, 0x77]); // VNC 固定 DES key

function bitrevBytes(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v |= ((buf[i] >> j) & 1) << (7 - j);
    out[i] = v;
  }
  return out;
}

// VNC 密码文件 = bitrev( DES_ECB( bitrev(明文补零到8), bitrev(key) ) )
function opensslVncEncrypt(pw: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const plain = Buffer.alloc(8);
    Buffer.from(pw, "ascii").copy(plain);
    const keyHex = bitrevBytes(VNC_KEY).toString("hex");
    const child = execFile(
      "openssl",
      ["des-ecb", "-provider", "legacy", "-provider", "default", "-K", keyHex, "-nopad"],
      { encoding: "buffer" as never, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err || !stdout || stdout.length !== 8) return reject(err ?? new Error("openssl 输出异常"));
        resolve(bitrevBytes(stdout));
      },
    );
    child.stdin?.end(bitrevBytes(plain));
  });
}

function writeWithVncpasswd(pw: string, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      "vncpasswd",
      ["-f"],
      { encoding: "buffer" as never, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err || !stdout || stdout.length < 8) return resolve(false);
        fsp
          .writeFile(target, stdout.subarray(0, 8), { mode: 0o600 })
          .then(() => resolve(true))
          .catch(() => resolve(false));
      },
    );
    child.stdin?.end(Buffer.from(pw, "ascii"));
  });
}

/** 把密码写入 passwd 文件。成功返回 null，失败返回错误信息。 */
export async function writeVncPassword(pw: string, target: string): Promise<string | null> {
  if (await writeWithVncpasswd(pw, target)) return null;
  try {
    const data = await opensslVncEncrypt(pw);
    await fsp.writeFile(target, data, { mode: 0o600 });
    return null;
  } catch {
    return "系统缺少 vncpasswd / openssl，无法写入 VNC 密码";
  }
}
