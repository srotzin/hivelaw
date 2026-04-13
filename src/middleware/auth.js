import { v4 as uuidv4 } from 'uuid';

const IS_DEV = process.env.NODE_ENV !== 'production';

function extractDID(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer did:hive:')) return auth.replace('Bearer ', '');
  const didHeader = req.headers['x-hivetrust-did'];
  if (didHeader && didHeader.startsWith('did:hive:')) return didHeader;
  return null;
}

function isValidDID(did) {
  if (!did || !did.startsWith('did:hive:')) return false;
  if (IS_DEV && did.startsWith('did:hive:test_agent_')) return true;
  return /^did:hive:[a-zA-Z0-9_-]{3,}$/.test(did);
}

export function requireDID(req, res, next) {
  const did = extractDID(req);
  if (did && isValidDID(did)) {
    req.agentDid = did;
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Authentication required',
    message: 'A valid HiveTrust DID is required. Provide it via Authorization: Bearer did:hive:xxx or X-HiveTrust-DID header.',
    hivetrust_registration_url: `${process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com'}/v1/register`,
  });
}
