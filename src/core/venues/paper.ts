// built-in venue: the paper-trading sandbox (see src/toolkit/paper.ts).
import path from 'node:path';
import { PaperExchange } from '../../toolkit/paper.ts';
import type { VenueContext, VenueModule } from './types.ts';

const venue: VenueModule = {
  id: 'paper',
  description: 'Simulated exchange account for developing strategies without risking capital. Not real money: register it only for testing.',
  async snapshot(ctx: VenueContext) {
    return new PaperExchange(path.join(ctx.dataDir, 'paper.json')).snapshot();
  },
};

export default venue;
