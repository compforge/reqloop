import type {
  Command,
  PluginCommandResult,
} from "@qiankun01/baton-plugin";

import type {
  Requirement,
  RequirementConnector,
  RequirementIdentity,
} from "./protocol.ts";

const REQUIREMENT_LIST_LIMIT = 50;

function requirementDetail(requirement: Requirement): string {
  const lines = [
    requirement.title,
    `Source: ${requirement.source}`,
    `ID: ${requirement.id}`,
    `Category: ${requirement.category}`,
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

function encodeRequirementIdentity(identity: RequirementIdentity): string {
  return JSON.stringify([
    identity.source,
    identity.category,
    identity.id,
  ]);
}

function decodeRequirementIdentity(value: string): RequirementIdentity {
  let identity: unknown;
  try {
    identity = JSON.parse(value);
  } catch {
    throw new Error("selected requirement identity is invalid");
  }
  if (
    !Array.isArray(identity) ||
    identity.length !== 3 ||
    typeof identity[0] !== "string" ||
    !identity[0] ||
    typeof identity[1] !== "string" ||
    !identity[1] ||
    typeof identity[2] !== "string" ||
    !identity[2]
  ) {
    throw new Error("selected requirement identity is invalid");
  }
  return {
    source: identity[0],
    category: identity[1],
    id: identity[2],
  };
}

export function createRequirementsCommand(
  connectors: readonly RequirementConnector[] = [],
): Command {
  const sources = new Set(connectors.map(({ source }) => source));
  if (sources.size !== connectors.length) {
    throw new Error("requirement connector sources must be unique");
  }
  return {
    commandId: "requirements",
    name: "requirements",
    description: "Browse requirements from the configured requirement platform",
    async execute(input) {
      if (connectors.length === 0) {
        return message(
          "ReqLoop has no requirement platform configured. Configure a RequirementConnector and reload plugins.",
        );
      }
      if (input.selectedValue) {
        const identity = decodeRequirementIdentity(input.selectedValue);
        const connector = connectors.find(
          ({ source }) => source === identity.source,
        );
        if (!connector) {
          throw new Error(
            `requirement source is not configured: ${identity.source}`,
          );
        }
        return message(
          requirementDetail(await connector.get(identity)),
        );
      }
      const text = input.argument.trim();
      const requirements = (
        await Promise.all(
          connectors.map((connector) =>
            connector.list({
              ...(text ? { text } : {}),
              limit: REQUIREMENT_LIST_LIMIT,
            }),
          ),
        )
      ).flat();
      if (requirements.length === 0) {
        return message(
          text
            ? `No requirements matched "${text}".`
            : "No requirements are available.",
        );
      }
      return {
        kind: "picker",
        title:
          connectors.length === 1
            ? `Requirements · ${connectors[0]!.source}`
            : `Requirements · ${connectors.length} sources`,
        options: requirements.map((requirement) => ({
          name: requirement.title,
          description: `${requirement.source} · ${requirement.category} · ${requirement.id} · ${requirement.state}`,
          value: encodeRequirementIdentity(requirement),
        })),
      };
    },
  };
}
