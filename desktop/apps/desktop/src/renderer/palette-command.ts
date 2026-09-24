export interface PaletteCommand {
  name: string;
  description?: string;
  source?: string;
}

// Resource templates need user input; commands are actions, never draft text.
export async function activatePaletteCommand(command: PaletteCommand, actions: {
  insertTemplate: (text: string) => void;
  executeBuiltin: (text: string) => Promise<boolean>;
  executeExtension: (text: string) => Promise<void>;
  unsupported: () => void;
}) {
  const text = `/${command.name}`;
  if (command.source === "prompt" || command.source === "skill") {
    actions.insertTemplate(`${text} `);
  } else if (command.source === "extension") {
    await actions.executeExtension(text);
  } else if (!await actions.executeBuiltin(text)) {
    actions.unsupported();
  }
}
