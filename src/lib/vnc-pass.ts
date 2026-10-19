import { execFile } from "child_process";
import fsp from "fs/promises";

// 写 tigervncserver 的密码文件 ~/.vnc/passwd（VNC 密码 ≤8 字节，8 字节 DES 密文）。
// 优先级：系统 vncpasswd -f（TigerVNC 自带，最权威）→ openssl CLI（legacy provider 的 DES-ECB）。
// 不用 Node crypto DES：Node ≥17 在 OpenSSL 3 下默认禁用 DES，运行时必须 --openssl-legacy-provider，不现实。

// VNC 固定 DES 密钥。注意 VNC 著名的「位反转」约定只体现在这个魔数里：
// 标准 vncpasswd 用原始密钥 {23,82,107,6,35,78,88,7}，其 DES 实现在生成子密钥时会逐字节
// 位反转，等效于直接用下面这个 key 做标准 DES —— 密码与密文都【不再】做任何位反转。
// 旧实现对明文和密文又各做了一次位反转、且魔数本身也不对，写出的 passwd 文件
// tigervncserver 根本不认（后台改完 VNC 密码后必然登录失败），这里按权威算法修正。
const VNC_KEY_HEX = "e84ad660c4721ae0";

// VNC 密码文件 = DES_ECB(明文补零到 8 字节, VNC 固定密钥)，密文原样写入
function opensslVncEncrypt(pw: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const plain = Buffer.alloc(8);
    Buffer.from(pw, "ascii").copy(plain);
    const child = execFile(
      "openssl",
      ["des-ecb", "-provider", "legacy", "-provider", "default", "-K", VNC_KEY_HEX, "-nopad"],
      { encoding: "buffer" as never, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err || !stdout || stdout.length !== 8) return reject(err ?? new Error("openssl 输出异常"));
        resolve(stdout);
      },
    );
    child.stdin?.end(plain);
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
