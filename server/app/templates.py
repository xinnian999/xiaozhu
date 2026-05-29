"""项目模板加载 —— 从磁盘读固定模板，给新 session 当起手种子。

为什么把"配置文件"从模板预置而不是让 LLM 生成？
  - 配置文件（package.json / vite.config.ts / tsconfig.json）是确定性样板，
    让 LLM 随机生成会有错版本号、缺依赖、把 eslint 一起塞进来等问题。
  - WebContainer 跑不起来时排查极难（npm install 失败堆栈在浏览器里）。
  - 模板就是一份"已验证可在 WebContainer 跑起来"的最小项目，零随机性。

模板放在 server/templates/<name>/ 下面，就是一个真实的 vite 项目，
本地可以 cd 进去 bun install && bun dev 验证它能跑。
"""

from pathlib import Path

# 项目根（server/）下的 templates 目录
_TEMPLATES_DIR = Path(__file__).parent.parent / "templates"

# 哪些目录/文件不应该写进 session 文件表
# node_modules / dist / .git 这些是构建产物或 vcs 元数据，绝对不能进库
_EXCLUDE_DIRS = {"node_modules", "dist", ".git", "__pycache__"}

# 我们只支持文本文件入库（File.content 是 Text 列）。
# 二进制资源（图片等）走数据库不划算，MVP 阶段直接跳过。
_TEXT_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".json", ".html", ".css", ".scss", ".md",
    ".txt", ".npmrc", ".gitignore", ".env",
}


def load_template(name: str = "vite-react") -> dict[str, str]:
    """读取一个模板目录，返回 {相对路径: 文件内容} 的字典。

    返回扁平字典是为了和 File 表结构对齐 —— 一行一个 (path, content)。
    """
    root = _TEMPLATES_DIR / name
    if not root.is_dir():
        raise FileNotFoundError(f"模板不存在: {root}")

    result: dict[str, str] = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue

        # 检查路径里有没有被排除的目录段
        if any(part in _EXCLUDE_DIRS for part in path.relative_to(root).parts):
            continue

        # 文本文件白名单。.npmrc / .gitignore 这种"没有真后缀"的特殊文件
        # 用 path.name 兜底
        if path.suffix not in _TEXT_SUFFIXES and path.name not in _TEXT_SUFFIXES:
            continue

        # 用 posix 风格的相对路径（统一用 /，跨平台一致）
        rel = path.relative_to(root).as_posix()
        result[rel] = path.read_text(encoding="utf-8")

    return result
