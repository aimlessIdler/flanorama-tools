from aiohttp import web
from markdown_it import MarkdownIt
from server import PromptServer


_markdown = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])


@PromptServer.instance.routes.post("/flanodes/markdown-preview")
async def markdown_preview(request):
    try:
        source = (await request.json())["text"]
    except (ValueError, TypeError, KeyError):
        return web.json_response({"error": "Expected Markdown text."}, status=400)
    if not isinstance(source, str) or len(source) > 100_000:
        return web.json_response({"error": "Preview supports up to 100,000 characters."}, status=400)
    return web.json_response({"html": _markdown.render(source)})


class MarkdownNote:
    """A note node that renders Markdown. Fenced code blocks get a 'Copy' button.

    Behaves like the built-in Note: it stores text but performs no graph work.
    All rendering and copy-button injection lives in web/markdownNote.js.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": (
                            "# Markdown Note\n\n"
                            "Write **markdown** here. Fenced code blocks get a Copy button.\n\n"
                            "```python\n"
                            "def hello():\n"
                            "    print(\"hi\")\n"
                            "```\n"
                        ),
                    },
                ),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = True
    CATEGORY = "Flanorama Tools/text"
    DESCRIPTION = "Keep formatted workflow notes with copyable code blocks."

    def noop(self, text):
        return {}
