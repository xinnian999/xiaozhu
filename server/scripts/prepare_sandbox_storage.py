"""为同容器内的无特权 Worker 准备可重复启动的共享目录权限。"""

from __future__ import annotations

import os
import stat as stat_module
import sys
from pathlib import Path


MARKER_NAME = ".worker-storage-owner-v1"


def _normalize_tree(
    root: Path,
    *,
    worker_uid: int,
    worker_gid: int,
    directory_mode: int,
    file_mode: int,
) -> None:
    """迭代取回所有权再后序交给 Worker，可处理超过递归上限的深目录。"""
    # 容器 root 没有 DAC/FOWNER，不能直接遍历或 chmod 10001:10001 的 0700 目录。
    # CAP_CHOWN 仍允许按已知路径先接管当前 inode；父目录变为 root 可读后再进入下一层。
    stack = [(root, False)]
    while stack:
        current_root, exiting = stack.pop()
        if exiting:
            # 目录最后交权；中断后下次仍从 marker 失效状态完整恢复。
            os.chown(current_root, worker_uid, worker_gid)
            continue

        os.chown(current_root, 0, 0)
        os.chmod(current_root, directory_mode)
        stack.append((current_root, True))
        with os.scandir(current_root) as scanner:
            for entry in scanner:
                target = Path(entry.path)
                if entry.is_symlink():
                    # jobs 可能残留可信 node_modules 链接，绝不能跟随到模板目录。
                    os.lchown(target, worker_uid, worker_gid)
                elif entry.is_dir(follow_symlinks=False):
                    stack.append((target, False))
                elif entry.is_file(follow_symlinks=False):
                    if entry.stat(follow_symlinks=False).st_nlink != 1:
                        raise RuntimeError(f"沙箱文件不能是硬链接: {target}")
                    os.chown(target, 0, 0)
                    os.chmod(target, file_mode)
                    os.chown(target, worker_uid, worker_gid)
                else:
                    raise RuntimeError(f"沙箱目录存在不支持的特殊文件: {target}")


def prepare_storage(
    data_dir: Path,
    worker_uid: int,
    worker_gid: int,
    *,
    force: bool = False,
) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    if data_dir.is_symlink():
        raise RuntimeError(f"沙箱数据目录不能是符号链接: {data_dir}")
    os.chown(data_dir, 0, 0)
    # owner=root 的 0700 允许安全创建或检查子目录；完成后再收紧为仅可穿越的 0711。
    os.chmod(data_dir, 0o700)

    jobs_dir = data_dir / "jobs"
    previews_dir = data_dir / "previews"
    jobs_dir.mkdir(exist_ok=True)
    previews_dir.mkdir(exist_ok=True)
    if jobs_dir.is_symlink() or previews_dir.is_symlink():
        raise RuntimeError("jobs/previews 目录不能是符号链接")

    marker = data_dir / MARKER_NAME
    marker_tmp = data_dir / f"{MARKER_NAME}.tmp"
    expected_marker = f"{worker_uid}:{worker_gid}\n"
    try:
        marker_info = marker.lstat()
        if not stat_module.S_ISREG(marker_info.st_mode) or marker_info.st_nlink != 1:
            raise RuntimeError(f"权限 marker 必须是单链接普通文件: {marker}")
        marker_matches = (
            not force and marker.read_text(encoding="ascii") == expected_marker
        )
    except (OSError, UnicodeError):
        marker_matches = False

    def unlink_marker(path: Path) -> None:
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        if not stat_module.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError(f"权限 marker 必须是单链接普通文件: {path}")
        path.unlink()

    # 所有完整迁移都先让旧 marker 失效；中途被杀后，下次启动绝不能误走快速路径。
    if not marker_matches:
        unlink_marker(marker)
    unlink_marker(marker_tmp)

    if not marker_matches:
        # 旧镜像产物或中断迁移必须完整走一次；版本 marker 只在两棵树都成功后原子发布。
        _normalize_tree(
            jobs_dir,
            worker_uid=worker_uid,
            worker_gid=worker_gid,
            directory_mode=0o700,
            file_mode=0o600,
        )
        _normalize_tree(
            previews_dir,
            worker_uid=worker_uid,
            worker_gid=worker_gid,
            directory_mode=0o755,
            file_mode=0o644,
        )
        marker_tmp.write_text(expected_marker, encoding="ascii")
        os.chmod(marker_tmp, 0o600)
        os.replace(marker_tmp, marker)
    else:
        # 正常重启不递归扫描全部缓存，只校正顶层 inode；深层均由 marker 的原子提交保证。
        for tree, mode in ((jobs_dir, 0o700), (previews_dir, 0o755)):
            os.chown(tree, 0, 0)
            os.chmod(tree, mode)
            os.chown(tree, worker_uid, worker_gid)

    os.chown(data_dir, 0, 0)
    os.chmod(data_dir, 0o711)


def main() -> None:
    if len(sys.argv) not in (4, 5) or (
        len(sys.argv) == 5 and sys.argv[4] != "--force"
    ):
        raise SystemExit(
            "用法: prepare_sandbox_storage.py DATA_DIR WORKER_UID WORKER_GID [--force]"
        )
    data_dir = Path(sys.argv[1])
    worker_uid = int(sys.argv[2])
    worker_gid = int(sys.argv[3])
    if not data_dir.is_absolute() or worker_uid <= 0 or worker_gid <= 0:
        raise SystemExit("DATA_DIR 必须是绝对路径，Worker UID/GID 必须为正整数")
    prepare_storage(
        data_dir,
        worker_uid,
        worker_gid,
        force=len(sys.argv) == 5,
    )


if __name__ == "__main__":
    main()
