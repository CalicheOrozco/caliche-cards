import { MongoClient, type Db } from "mongodb";

const MONGODB_DB = process.env.MONGODB_DB || "caliche-cards";

function getMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "Missing MONGODB_URI in environment. Set it in .env.local (or .env) and restart `npm run dev`."
    );
  }
  return uri;
}

declare global {
   
  var _mongoClientPromise: Promise<MongoClient> | undefined;
  var _mongoClientUri: string | undefined;
}

export async function getMongoClient(): Promise<MongoClient> {
  const uri = getMongoUri();

  // Cache the client across hot reloads in dev, and across requests in prod
  // (important for serverless/edge-like environments to avoid reconnect storms).
  if (!global._mongoClientPromise || global._mongoClientUri !== uri) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    });
    global._mongoClientPromise = client.connect();
    global._mongoClientUri = uri;
  }

  return global._mongoClientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(MONGODB_DB);
}
