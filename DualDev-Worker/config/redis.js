import { config } from "dotenv";

config();

const redisConfig = {

  host:                 process.env.REDIS_HOST,

  port:                 Number(process.env.REDIS_PORT),

  username:             "default",

  password:             process.env.REDIS_PASSWORD,

  maxRetriesPerRequest: null,

  connectTimeout: 10000,

  keepAlive: 30000
};

export default redisConfig;
