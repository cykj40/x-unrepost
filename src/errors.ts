/** A user-fixable problem (bad env, bad criteria). Printed one line per problem, no stack. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
    this.problems = problems;
  }
}
