class VariableToggle:
    """Replaces a variable string in a prompt with one of two predefined terms."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "variable": ("STRING", {"default": "{VAR}"}),
                "term_1": ("STRING", {"default": ""}),
                "term_2": ("STRING", {"default": ""}),
                "use_term": (["Term 1", "Term 2"],),
            },
            "optional": {
                "replace_scope": (["All occurrences", "First occurrence"], {"default": "All occurrences"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
    FUNCTION = "replace"
    CATEGORY = "Flanorama Tools/text"
    DESCRIPTION = "Swap a literal placeholder between two terms to compare prompt variations."

    def replace(self, prompt, variable, term_1, term_2, use_term, replace_scope="All occurrences"):
        if not variable:
            return (prompt,)
        replacement = term_1 if use_term == "Term 1" else term_2
        count = 1 if replace_scope == "First occurrence" else -1
        result = prompt.replace(variable, replacement, count)
        return (result,)
