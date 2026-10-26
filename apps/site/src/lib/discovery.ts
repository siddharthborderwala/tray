import { SITE_URL } from "./site";
import { skillDescription, skillDigest, skillText } from "./skill";

/** Agent Skills discovery index (https://schemas.agentskills.io/discovery/0.2.0). */
export function skillsIndex(): Response {
  const text = skillText();
  const body = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "tray",
        type: "skill-md",
        description: skillDescription(text),
        url: `${SITE_URL}/skill.md`,
        digest: skillDigest(text),
      },
    ],
  };
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    headers: { "content-type": "application/json" },
  });
}
