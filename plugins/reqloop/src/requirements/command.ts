import type {
  PluginCommandContribution,
  PluginCommandResult,
} from "@qiankun01/baton-plugin";

import type {
  Requirement,
  RequirementConnector,
} from "./protocol.ts";

const REQUIREMENT_LIST_LIMIT = 50;

function requirementDetail(requirement: Requirement): string {
  const lines = [
    requirement.title,
    `ID: ${requirement.id}`,
    `Status: ${requirement.state}`,
    ...(requirement.assignee ? [`Assignee: ${requirement.assignee}`] : []),
    ...(requirement.updatedAt ? [`Updated: ${requirement.updatedAt}`] : []),
    ...(requirement.url ? [`URL: ${requirement.url}`] : []),
    ...(requirement.description ? ["", requirement.description] : []),
  ];
  if (requirement.acceptanceCriteria?.length) {
    lines.push(
      "",
      "Acceptance criteria:",
      ...requirement.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    );
  }
  return lines.join("\n");
}

function message(text: string): PluginCommandResult {
  return { kind: "message", text };
}

export function createRequirementsCommand(
  connector?: RequirementConnector,
): PluginCommandContribution {
  return {
    commandId: "requirements",
    name: "requirements",
    description: "Browse requirements from the configured requirement platform",
    async execute(input) {
      if (!connector) {
        return message(
          "ReqLoop has no requirement platform configured. Configure a RequirementConnector and reload plugins.",
        );
      }
      if (input.selectedValue) {
        return message(
          requirementDetail(await connector.get(input.selectedValue)),
        );
      }
      const text = input.argument.trim();
      const requirements = await connector.list({
        ...(text ? { text } : {}),
        limit: REQUIREMENT_LIST_LIMIT,
      });
      if (requirements.length === 0) {
        return message(
          text
            ? `No requirements matched "${text}".`
            : "No requirements are available.",
        );
      }
      return {
        kind: "picker",
        title: `Requirements · ${connector.provider}`,
        options: requirements.map((requirement) => ({
          name: requirement.title,
          description: `${requirement.id} · ${requirement.state}`,
          value: requirement.id,
        })),
      };
    },
  };
}
