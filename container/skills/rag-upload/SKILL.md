---
name: rag-upload
description: RAG 知识库管理技能，负责文档的写入、更新、删除、列表等管理操作。触发场景：用户说"上传到知识库"、"列出知识库文档"、"删除文档"、"更新知识库"、"管理知识库内容"、"把这个存进知识库"等写入/管理类动作。注意：查询类问题（如"如何做 X"、"X 的步骤"）不归本 skill，应由 remote-rag-expert 处理。
metadata:
  openclaw:
    emoji: "📚"
    requires:
      bins: ["lark-cli"]
---

# RAG 知识库操作规范

## 主要操作：本地 RAG API（localhost:7001）

使用 `exec` 工具运行 `bridge.py`：

### 1. 列出知识库文档
```bash
python3 {baseDir}/bridge.py list
```

### 2. 删除指定文档
```bash
python3 {baseDir}/bridge.py delete --doc-id <DOC_ID>
```

### 3. 上传文档
```bash
python3 {baseDir}/bridge.py upload --file <FILE_PATH>
```

### 4. 重新上传（先删后传）
```bash
python3 {baseDir}/bridge.py reupload --file <FILE_PATH> --doc-id <OLD_DOC_ID>
python3 {baseDir}/bridge.py reupload --file <FILE_PATH>
```

## API 端点

| 操作 | 方法 | 端点 |
|------|------|------|
| 列出文档 | GET | `/api/knowledge/documents` |
| 删除文档 | DELETE | `/api/knowledge/documents/<doc_id>` |
| 上传文档 | POST | `/api/knowledge/upload` |

## 飞书云盘镜像（lark-drive + lark-wiki）

上传到本地 RAG 的同时，同步一份到飞书，便于团队共享和浏览：

```bash
# 上传至飞书云盘
lark-cli drive +upload --file <FILE_PATH> --folder-token <KB_FOLDER_TOKEN>

# 若文档为知识库文章，同步至飞书知识库
lark-cli docs +create --title "<文档标题>" --wiki-space <WIKI_SPACE_ID> --markdown "<Markdown内容>"
```

## 注意事项

- 文件需先保存在 `/Users/realityloop/.openclaw/workspace/doc/` 或其他可访问路径
- 重新上传时会自动匹配文件名删除旧文档
- **删除操作**：同时删除 RAG 知识库记录和本地文件；飞书云盘文件需手动删除
- lark-drive 上传失败不阻断主流程
