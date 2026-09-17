// The help text, kept apart from the command wiring so neither obscures the other.
export const usage = `harness-bridge — launch a coding harness on any OpenAI/Anthropic-compatible endpoint

  providers | providers add --name N --url U --key K [--apis chat,messages] [--reasoning <level>]
  providers rm <id> | use <id> | reasoning <level> [provider] | show <id> [--json]
  models [provider]                  list live models
  use <model> [provider]             select a model (only the selection is persisted)
  harnesses [provider]               what is installed, and what this endpoint can drive
  install <harness>                  install a harness so it can be launched
  run [model] [harness]              open a session; --print | --exec | --no-install
                                     --provider <id> | --dir <path> | -- <harness flags>
  pin|unpin <model> | pins           keep models in the main view
  dir [path]                         where sessions open (default: this shell's directory)
  terminal [id|auto|custom] --command "<t>"   which terminal sessions open in
  snapshot [--json] | status | config   the whole state, a summary, or the file path
`;
