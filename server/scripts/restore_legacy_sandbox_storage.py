"""失败回滚到旧 root Worker 前，安全恢复沙箱缓存的旧权限模型。"""

from __future__ import annotations

import os
import sys
from pathlib import Path


MARKER_NAMES = (
    ".worker-storage-owner-v1",
    ".worker-storage-owner-v1.tmp",
)


def _restore_tree(root: Path, *, directory_mode: int, file_mode: int) -> None:
    """迭代且不跟随符号链接，把任意深度的缓存树恢复为 root 所有。"""
    stack = [root]
    while stack:
        current_root = stack.pop()
        os.chown(current_root, 0, 0)
        os.chmod(current_root, directory_mode)
        with os.scandir(current_root) as scanner:
            for entry in scanner:
                target = Path(entry.path)
                if entry.is_symlink():
                    # jobs 中可能残留可信 node_modules 链接，只改链接自身，绝不越界。
                    os.lchown(target, 0, 0)
                elif entry.is_dir(follow_symlinks=False):
                    stack.append(target)
                elif entry.is_file(follow_symlinks=False):
                    if entry.stat(follow_symlinks=False).st_nlink != 1:
                        raise RuntimeError(f"沙箱文件不能是硬链接: {target}")
                    os.chown(target, 0, 0)
                    os.chmod(target, file_mode)
                else:
                    raise RuntimeError(f"沙箱目录存在不支持的特殊文件: {target}")


def restore_legacy_storage(data_dir: Path) -> None:
    """恢复旧 Worker 可读写的权限，并让新镜像下次重新执行完整交权。"""
    if not data_dir.is_absolute() or data_dir.is_symlink():
        raise RuntimeError("沙箱数据目录必须是非符号链接的绝对路径")
    if not data_dir.is_dir():
        raise RuntimeError(f"沙箱数据目录不存在: {data_dir}")

    # marker 必须先失效：即使后续递归被 OOM/SIGKILL 或异常文件打断，新镜像也会
    # 在下次启动重新做完整交权，不能误走只校正顶层 inode 的快速路径。
    for marker_name in MARKER_NAMES:
        marker = data_dir / marker_name
        if marker.is_symlink():
            raise RuntimeError(f"权限 marker 不能是符号链接: {marker}")
        marker.unlink(missing_ok=True)

    os.chown(data_dir, 0, 0)
    os.chmod(data_dir, 0o700)
    jobs_dir = data_dir / "jobs"
    previews_dir = data_dir / "previews"
    jobs_dir.mkdir(exist_ok=True)
    previews_dir.mkdir(exist_ok=True)
    if jobs_dir.is_symlink() or previews_dir.is_symlink():
        raise RuntimeError("jobs/previews 目录不能是符号链接")

    _restore_tree(jobs_dir, directory_mode=0o700, file_mode=0o600)
    _restore_tree(previews_dir, directory_mode=0o755, file_mode=0o644)
    os.chown(data_dir, 0, 0)
    os.chmod(data_dir, 0o711)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("用法: restore_legacy_sandbox_storage.py DATA_DIR")
    restore_legacy_storage(Path(sys.argv[1]))


if __name__ == "__main__":
    main()
