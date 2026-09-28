"use strict";

class Votes {
  constructor(config, members, onFinish) {
    Object.assign(this, { config, members, onFinish });
    this.active = null;
    this.sequence = 0;
  }

  counts(vote = this.active) {
    const eligible = this.members();
    let yes = 0,
      no = 0;
    if (vote)
      for (const [id, choice] of vote.ballots) {
        if (eligible.has(id)) {
          if (choice === "yes") yes++;
          else no++;
        }
      }
    return { yes, no, eligible: eligible.size };
  }

  start(details) {
    if (this.active) return null;
    const id = ++this.sequence;
    const vote = {
      ...details,
      id,
      ballots: new Map(),
      endsAt: Date.now() + this.config.voteDurationMs,
    };
    if (this.members().has(details.requesterId))
      vote.ballots.set(details.requesterId, "yes");
    vote.timer = setTimeout(() => this.finish(id), this.config.voteDurationMs);
    vote.timer.unref?.();
    this.active = vote;
    return vote;
  }

  cast(userId, choice) {
    const vote = this.active;
    if (!vote || !this.members().has(userId)) return null;
    vote.ballots.set(userId, choice);
    const counts = this.counts(vote);
    // Finalize before any asynchronous message send can expire or replace this vote.
    if (counts.eligible && counts.yes + counts.no >= counts.eligible)
      this.finish(vote.id);
    return counts;
  }

  finish(id) {
    const vote = this.active;
    if (!vote || vote.id !== id) return;
    const counts = this.counts(vote);
    this.clear();
    this.onFinish(
      vote,
      counts.yes > counts.no && counts.yes >= this.config.voteMinimumYes,
      counts,
    );
  }

  clear() {
    if (this.active) clearTimeout(this.active.timer);
    this.active = null;
  }
}

module.exports = { Votes };
