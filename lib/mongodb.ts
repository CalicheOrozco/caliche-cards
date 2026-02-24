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

  if (process.env.NODE_ENV === "development") {
    if (!global._mongoClientPromise || global._mongoClientUri !== uri) {
      const client = new MongoClient(uri);
      global._mongoClientPromise = client.connect();
      global._mongoClientUri = uri;
    }
    return global._mongoClientPromise;
  }

  const client = new MongoClient(uri);
  return client.connect();
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(MONGODB_DB);
}
