// The pseudonym that stands for a document's title when an inviter hides the
// title from an invitee (register D202, Q49): "Flying Hippos — {display name}".
// It is made once, when the invitation is created, and kept in the invitation's
// row (`titlePseudonym`), so that the page, the notification and the email show
// the same words. It is not the title and carries nothing of the document: two
// words and the display name of the sender, so that the sender can tell the
// invitee what to look for. It is not a secret, and the invitee's account is
// what decides who sees the title, not the pseudonym.
//
// The words are short, neutral and kind, for the owner's approval (the lists
// are not in the specification). The choice of each word is made with the
// platform's cryptographic random source (`randomInt`), never `Math.random`
// (a test reads this file for it).
import { randomInt } from 'node:crypto';

export const PSEUDONYM_ADJECTIVES = [
  'Amber',
  'Brave',
  'Bright',
  'Calm',
  'Cheerful',
  'Clever',
  'Cosy',
  'Curious',
  'Dapper',
  'Eager',
  'Fluffy',
  'Flying',
  'Gentle',
  'Golden',
  'Happy',
  'Jolly',
  'Kind',
  'Lively',
  'Merry',
  'Mighty',
  'Nimble',
  'Patient',
  'Quiet',
  'Rapid',
  'Silver',
  'Sleepy',
  'Sunny',
  'Swift',
  'Tidy',
  'Wandering',
  'Wise',
  'Witty',
] as const;

export const PSEUDONYM_ANIMALS = [
  'Badgers',
  'Beavers',
  'Bluebirds',
  'Dolphins',
  'Ducks',
  'Falcons',
  'Foxes',
  'Frogs',
  'Giraffes',
  'Hedgehogs',
  'Herons',
  'Hippos',
  'Koalas',
  'Lemurs',
  'Llamas',
  'Otters',
  'Owls',
  'Pandas',
  'Parrots',
  'Pelicans',
  'Penguins',
  'Puffins',
  'Rabbits',
  'Seals',
  'Sparrows',
  'Squirrels',
  'Swans',
  'Tortoises',
  'Turtles',
  'Walruses',
  'Whales',
  'Wombats',
] as const;

/**
 * "Flying Hippos — Ada Owner": an adjective and an animal chosen at random,
 * then the sender's display name (FR-ED-17). `pick(n)` answers a whole number
 * from 0 up to n, not including it; a test gives its own.
 */
export function newPseudonym(senderName: string, pick: (n: number) => number = randomInt): string {
  const adjective = PSEUDONYM_ADJECTIVES[pick(PSEUDONYM_ADJECTIVES.length)];
  const animal = PSEUDONYM_ANIMALS[pick(PSEUDONYM_ANIMALS.length)];
  return `${adjective} ${animal} — ${senderName}`;
}

/** How many times a pseudonym that is already in use is drawn again before one is kept (1,024 pairs, a handful in use). */
const REDRAWS = 32;

/**
 * As `newPseudonym`, drawn again where the words are among `taken`: the open hidden invitations of this sender to
 * this address, so that an invitee who holds several can tell them apart ("what to look for"). After
 * `REDRAWS` draws the last is kept: a pseudonym is not a key, and two alike harm nothing but that.
 */
export function newPseudonymAvoiding(
  senderName: string,
  taken: ReadonlySet<string>,
  pick: (n: number) => number = randomInt,
): string {
  let made = newPseudonym(senderName, pick);
  for (let n = 1; n < REDRAWS && taken.has(made); n += 1) made = newPseudonym(senderName, pick);
  return made;
}
