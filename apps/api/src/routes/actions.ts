import { Router, type Request, type Response } from 'express';
import { ListActionsQuerySchema } from '../validators.js';
import { readLimiter } from '../middleware/rateLimiter.js';
import { listActions } from '../services/db.js';
import { logger } from '../logger.js';

export const actionsRouter: Router = Router();

// GET /actions?agentId=&status=&type=&limit=&offset=
actionsRouter.get('/', readLimiter, (req: Request, res: Response) => {
  const parsed = ListActionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', issues: parsed.error.issues });
    return;
  }
  try {
    const { actions, total } = listActions(parsed.data);
    res.json({
      actions,
      total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
  } catch (err) {
    logger.error({ err }, 'GET /actions error');
    res.status(500).json({ error: 'Failed to list actions' });
  }
});
