import comfy.samplers


class SimpleSamplerConfig:
    """Share one sampler and scheduler choice across multiple nodes."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"tooltip": "Connect SAMPLER to a sampler_name input."}),
                "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"tooltip": "Connect SCHEDULER to a scheduler input."}),
            },
        }

    # Keep existing connections to third-party nodes with differing combo lists.
    RETURN_TYPES = ("*", "*")
    RETURN_NAMES = ("SAMPLER", "SCHEDULER")
    
    FUNCTION = "main"
    CATEGORY = "Flanorama Tools/sampling"
    DESCRIPTION = "Set the sampler and scheduler once and wire them to multiple sampler widgets."

    def main(self, sampler_name, scheduler):
        return (sampler_name, scheduler)
