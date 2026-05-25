FROM ghcr.io/berriai/litellm:main-latest

# Copy our custom configuration file into the image
COPY config.yaml /app/config.yaml

# Set default host and port environment variables for LiteLLM
ENV PORT=4000
ENV HOST=0.0.0.0

# Expose the proxy port
EXPOSE 4000

# Start LiteLLM with our config, dynamically binding to the port Railway expects
CMD ["--config=/app/config.yaml", "--port=4000", "--host=0.0.0.0"]
