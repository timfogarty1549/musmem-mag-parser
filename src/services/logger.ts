import winston from 'winston';

const logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss.SSS Z'
    }),
    winston.format.prettyPrint(),
    // winston.format.colorize(),
    winston.format.printf((info) => {
      return `${info.level}: ${info.message}`;
    })
  ),
  transports: [
    new winston.transports.Console()
  ]
});

export default logger; 