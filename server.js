'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('express-jwt');

const ZIPKIN_URL = process.env.ZIPKIN_URL || 'http://zipkin:80/api/v2/spans';
const {
  Tracer,
  BatchRecorder,
  jsonEncoder: { JSON_V2 }
} = require('zipkin');
const CLSContext = require('zipkin-context-cls');
const { HttpLogger } = require('zipkin-transport-http');
const zipkinMiddleware = require('zipkin-instrumentation-express').expressMiddleware;

const logChannel = process.env.REDIS_CHANNEL || 'log_channel';
const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort =  6379;

const redis = require('redis');
const redisClient = redis.createClient({
  host: redisHost,
  port: redisPort,
  retry_strategy: function (options) {
    if (options.error && options.error.code === 'ECONNREFUSED') {
      console.error('❌ Redis: Connection refused');
      return new Error('The server refused the connection');
    }
    if (options.total_retry_time > 1000 * 60 * 60) {
      console.error('❌ Redis: Retry time exhausted');
      return new Error('Retry time exhausted');
    }
    if (options.attempt > 10) {
      console.warn(`⚠️ Redis: Too many attempts (${options.attempt}), stopping retries.`);
      return undefined;
    }
    return Math.min(options.attempt * 100, 2000);
  }
});

// Capturar errores no manejados
redisClient.on('error', (err) => {
  console.error('❌ Redis error:', err);
});

// Confirmar conexión
redisClient.on('ready', () => {
  console.log('✅ Redis client is ready and connected');
});

const port = process.env.TODO_API_PORT || 8082;
const jwtSecret = process.env.JWT_SECRET || 'foo';

const app = express();

// Tracing setup
const ctxImpl = new CLSContext('zipkin');
const recorder = new BatchRecorder({
  logger: new HttpLogger({
    endpoint: ZIPKIN_URL,
    jsonEncoder: JSON_V2
  })
});
const localServiceName = 'todos-api';
const tracer = new Tracer({ ctxImpl, recorder, localServiceName });

// Middleware
app.use(jwt({ secret: jwtSecret, algorithms: ['HS256'] }).unless({ path: ['/health'] }));

app.use(zipkinMiddleware({ tracer }));

app.use((err, req, res, next) => {
  if (err.name === 'UnauthorizedError') {
    return res.status(401).send({ message: 'invalid token' });
  }
  console.error('❌ General error:', err);
  next(err);
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Routes
const routes = require('./routes');
routes(app, { tracer, redisClient, logChannel });

// Healthcheck
app.get('/health', (req, res) => {
  res.status(200).send({ status: 'OK' });
});

// Start server
app.listen(port, () => {
  console.log('🚀 Todo list RESTful API server started on port:', port);
});
