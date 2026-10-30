/**
 * The names that stand for more than one thing in this news, and the words that tell
 * the readings apart.
 *
 * The glossary is shared: a term explained for one story is marked in every story and
 * article that names it. A name that means two things needs more than that. "PT" is
 * Lula's Workers' Party in one story and the Pacific time zone in half a dozen others;
 * "RTS" is Radio Television of Serbia in one and a real-time strategy game in several;
 * "GR" is a Debian General Resolution and a Fourier robot; "ORG" is the Open Rights
 * Group and a placeholder in a shell command; "Cube" is Roblox's generative AI system
 * and a solid with six square faces; "Kitty" is a terminal emulator in one story and
 * the character on the merchandise in another.
 *
 * A name with a reading is marked where the words of its reading stand near it: "PT" is
 * marked where the sentence says party, workers or Lula, and nowhere else. The words are
 * the ones the news itself uses with the term.
 *
 * The strong words are the ones no other reading uses: "homeland security" belongs to
 * the federal agency and to nothing else. A text that has one of them is about that
 * reading throughout, and the name is marked wherever it stands in it. The weak words
 * are ordinary ones — "party", "gpu", "agent" — and they only count when they stand
 * close to the name.
 */
export interface Reading {
  /** Words that only this reading uses. A text that has one is about this reading. */
  strong: string[];
  /** Ordinary words that tell the readings apart when they stand near the name. */
  weak: string[];
}

export const READINGS: Record<string, Reading> = {
  // The Workers' Party of Brazil, and the Pacific time zone.
  pt: { strong: ['lula', 'arbeiterpartei'], weak: ['party', 'workers', 'worker', 'brasil', 'brazil'] },
  // Radio Television of Serbia, and the genre of a strategy game.
  rts: { strong: ['serbia', 'serbien', 'fernsehen', 'rundfunk'], weak: ['sender', 'broadcaster', 'television'] },
  // The audit of PingCAP's code, and a label in a machine-learning paper.
  ncc: { strong: ['pingcap', 'tidb'], weak: ['audit', 'reviewer', 'security audit'] },
  // Debian's General Resolution, and a Fourier robot.
  gr: { strong: ['debian'], weak: ['resolution', 'maintainer', 'debian-vote', 'gr text', 'generative ai'] },
  // The Security Service of Ukraine, and a dataset of image captions.
  sbu: { strong: ['ukraine', 'ukrainisch', 'ukrainer'], weak: ['geheimdienst', 'intelligence', 'fsb'] },
  // The Open Rights Group, and a placeholder in a shell command.
  org: { strong: ['open rights group'], weak: ['rights', 'advocacy', 'campaign'] },
  // Google's protocol for agents to talk to each other, and a variable in a formula.
  a2a: { strong: ['aaif', 'agent2agent', 'agent-to-agent'], weak: ['agent', 'protocol', 'interoperab'] },
  // The convolutional network, and the news channel.
  cnn: {
    strong: ['mnist', 'convolutional', 'acoustical', 'object detection', 'atari', 'receptive field', 'cnn layers', 'cnn encoder', 'cnn feature'],
    weak: ['neural network', 'classifier', 'pooling', 'feature map', 'rnn', 'lstm', 'gnn', 'recurrent', 'computer vision'],
  },
  // The federal agency, and everything else the letters stand for.
  ice: {
    strong: ['homeland security', 'einwanderung', 'einwanderungs', 'customs and border', 'immigration and customs', 'ice agents', 'ice officers', 'ice enforcement'],
    weak: ['immigration', 'customs', 'enforcement', 'deport', 'officer', 'detain', 'immigrant', 'border', 'raid'],
  },
  // The proof assistant, and the adjective for something without fat.
  lean: { strong: ['mathlib', 'lean 4', 'lean code', 'lean data'], weak: ['proof', 'theorem', 'tactic', 'mathematic', 'lemma', 'verified', 'formal'] },
  // Roblox's generative AI system, and a solid with six square faces.
  cube: { strong: ['roblox'], weak: ['generative', 'foundation model', 'mesh'] },
  // Chromium's WebGPU implementation, and the time before sunrise.
  dawn: { strong: ['webgpu', 'chromium'], weak: ['shader', 'graphics'] },
  // The cyber-research product, and the person who fights adversity.
  hero: { strong: ['threat hunting', 'cyber research', 'cyber-research'], weak: ['cyber', 'autonomous', 'research'] },
  // The cybersecurity company, and what the mind does while asleep.
  dream: { strong: ['threat hunting', 'malware', 'cyber research'], weak: ['cyber', 'security', 'threat', 'attack', 'researcher'] },
  // Apple's graphics API, and the element.
  metal: { strong: ['metal performance primitives', 'metal kernel', 'metal backend', 'apple silicon'], weak: ['apple', 'macos', 'gpu', 'kernel', 'shader', 'graphics'] },
  // The cloud provider, and the adjective for a window that blocks the rest.
  modal: { strong: ['modal.com', 'modal labs', "modal's", 'modal’s'], weak: ['sandbox', 'provider', 'infrastructure', 'container'] },
  // The Australian party, and the word for work.
  labor: { strong: ['australia', 'australian', 'labor party'], weak: ['federal', 'party', 'alp'] },
  // The open-source workspace, and the noise a bee makes.
  buzz: { strong: ['buzz.xyz', 'jack dorsey'], weak: ['workspace', 'channel', 'attestation', 'open source'] },
  // The browser engine, and what the eyes do.
  blink: { strong: ['chromium', 'webkit', 'browser engine'], weak: ['engine', 'rendering'] },
  // The terminal emulator, and the character whose face is on the merchandise.
  kitty: {
    strong: ['kitty graphics', 'kitty protocol', 'terminal emulator', 'kovidgoyal', 'ghostty'],
    weak: ['terminal', 'graphics', 'ssh', 'clipboard', 'emulator', 'protocol'],
  },
};
