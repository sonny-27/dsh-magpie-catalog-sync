import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_BRIDGE_REVISION = 'local-reference-images-v1';
const MAX_IMAGE = 10 * 1024 * 1024, MAX_TOTAL = 20 * 1024 * 1024, MAX_COUNT = 16;
const invalid = message => Object.assign(new Error(message), { code: 'REFERENCE_IMAGE_ERROR' });
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

export function imageMediaType(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw invalid('参考图不是受支持的 PNG、JPEG、WebP 或 GIF 图片。请重新上传图片。');
}

// The authenticated local MCP endpoint may read images, never arbitrary files.
// Real paths must remain within the attachment store or a registered workspace.
export function createReferenceImages({ getRoots, getWorkingDirectory, normalizeImage, attachmentRoot }) {
  return async (references, signal) => {
    if (!Array.isArray(references) || references.length > MAX_COUNT) throw invalid('参考图必须是图片地址数组，每次最多 16 张。');
    const roots = await getRoots();
    const realRoots = (await Promise.all(roots.map(root => fs.realpath(root).catch(() => undefined)))).filter(Boolean);
    const output = []; let total = 0;
    for (const reference of references) {
      signal?.throwIfAborted();
      if (typeof reference !== 'string' || !reference || reference.length > 16 * 1024 * 1024) throw invalid('参考图地址无效。');
      if (/^https?:\/\//i.test(reference)) {
        try { const url = new URL(reference); if (!url.hostname || url.username || url.password) throw new Error(); }
        catch { throw invalid('参考图网络地址无效。'); }
        output.push(reference); continue;
      }
      if (/^data:/i.test(reference)) {
        const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(reference);
        if (!match) throw invalid('参考图数据地址必须包含受支持的图片和 Base64 数据。');
        const bytes = Buffer.byteLength(match[2], 'base64');
        if (bytes > MAX_IMAGE) throw invalid('单张参考图不能超过 10 MiB。');
        total += bytes;
        if (total > MAX_TOTAL) throw invalid('参考图总大小不能超过 20 MiB。');
        output.push(reference); continue;
      }
      let candidate = reference;
      const hash = /^sha256:([a-f0-9]{64})$/i.exec(candidate);
      if (hash && attachmentRoot) candidate = path.join(attachmentRoot, 'objects', hash[1].slice(0, 2).toLowerCase(), hash[1].toLowerCase());
      else if (/^file:/i.test(candidate)) {
        try {
          const url = new URL(candidate);
          if (url.hostname && url.hostname !== 'localhost') throw new Error();
          if (url.search || url.hash) throw new Error();
          candidate = fileURLToPath(url);
        } catch { throw invalid('参考图只支持本机文件，不支持网络共享路径。'); }
      }
      // Reject UNC, device paths, alternate streams, drive-relative paths and other schemes.
      if (candidate.length > 4096 || /[\0\r\n]/.test(candidate) || /^[\\/]{2}/.test(candidate) ||
          /^[a-z]:[^\\/]/i.test(candidate) || /:/.test(candidate.replace(/^[a-z]:/i, ''))) {
        throw invalid('参考图本地路径无效，不支持网络共享、设备路径或其他协议。');
      }
      const file = path.resolve(await getWorkingDirectory(), candidate);
      if (!roots.some(root => inside(path.resolve(root), file))) throw invalid('参考图不在附件库或已登记的工作区内。请将图片上传到当前会话后重试，不要改用纯文字重画。');
      let canonical;
      try { canonical = await fs.realpath(file); }
      catch { throw invalid('本机找不到参考图。请重新上传原图后重试，不要改用纯文字重画。'); }
      if (!realRoots.some(root => inside(root, canonical))) throw invalid('参考图链接指向工作区以外的文件，已拒绝读取。');
      let data;
      try {
        const handle = await fs.open(canonical, 'r');
        try {
          const stat = await handle.stat(), current = await fs.realpath(canonical), currentStat = await fs.stat(current);
          if (!realRoots.some(root => inside(root, current)) || stat.ino !== currentStat.ino || stat.dev !== currentStat.dev) throw invalid('参考图路径已变化，请重新上传。');
          if (!stat.isFile()) throw invalid('参考图必须是普通图片文件。');
          if (stat.size > MAX_IMAGE) throw invalid('单张参考图不能超过 10 MiB。');
          // Bounded reads also handle a file growing after stat().
          const buffer = Buffer.alloc(stat.size + 1); let length = 0;
          while (length < buffer.length) {
            signal?.throwIfAborted();
            const read = await handle.read(buffer, length, buffer.length - length, null);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (length !== stat.size) throw invalid('读取过程中参考图发生变化，请重试。');
          data = buffer.subarray(0, length);
        } finally { await handle.close(); }
      } catch (error) {
        if (error.code === 'REFERENCE_IMAGE_ERROR' || signal?.aborted) throw error;
        throw invalid('本机无法读取参考图，请重新上传图片。');
      }
      const mediaType = imageMediaType(data);
      if (!normalizeImage) throw invalid('宿主未提供图片验证服务，无法安全读取本地参考图。请更新客户端或提供图片数据地址。');
      let normalized;
      try { normalized = await normalizeImage({ data, mediaType }, signal); }
      catch (error) {
        if (error.code === 'REFERENCE_IMAGE_ERROR' || signal?.aborted) throw error;
        throw invalid('宿主图片验证失败，请重新上传有效图片。');
      }
      const bytes = Buffer.from(normalized?.data ?? []);
      const normalizedType = imageMediaType(bytes);
      if (!bytes.length || bytes.length > MAX_IMAGE) throw invalid('验证后的参考图大小无效。');
      total += bytes.length;
      if (total > MAX_TOTAL) throw invalid('参考图总大小不能超过 20 MiB。');
      output.push(`data:${normalizedType};base64,${bytes.toString('base64')}`);
    }
    return output;
  };
}

export function createHostReferenceImages({ home, getWorkingDirectory, getAttachmentStore }) {
  const attachmentRoot = path.join(home, 'attachments', 'v1');
  const directory = () => getWorkingDirectory?.() ?? process.cwd();
  return createReferenceImages({ attachmentRoot, getWorkingDirectory: directory,
    getRoots: async () => {
      const roots = [attachmentRoot, directory()];
      try {
        const data = await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8');
        if (data.length > 2 * 1024 * 1024) throw new Error('Workspace metadata too large');
        const state = JSON.parse(data);
        for (const id of state.global?.workspaceIds ?? []) {
          const workspace = state.tables?.workspaces?.[id];
          if (typeof workspace?.path === 'string' && path.isAbsolute(workspace.path)) roots.push(workspace.path);
        }
      } catch { /* DSH can use its workingDirectory without DSBot workspace metadata. */ }
      // Never implicitly grant the filesystem root or all of the user's private home.
      return [...new Set(roots.filter(root => typeof root === 'string' && path.isAbsolute(root) && path.parse(root).root !== path.resolve(root) && path.resolve(root) !== path.resolve(home)))];
    },
    normalizeImage: async (input, signal) => {
      const store = getAttachmentStore?.();
      if (!store?.saveImage || !store?.readImage) throw invalid('宿主未提供图片验证服务，请更新客户端或提供图片数据地址。');
      signal?.throwIfAborted();
      const ref = await store.saveImage(input);
      return store.readImage(ref, signal);
    },
  });
}
