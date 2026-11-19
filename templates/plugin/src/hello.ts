// Command logic lives in plain functions so tests can call it without spawning the CLI.

export interface Greeting {
  greeting: string;
}

export function hello(name: string): Greeting {
  return { greeting: `Hello, ${name}!` };
}
