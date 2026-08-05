FROM ghcr.io/berriai/litellm:v1.92.1@sha256:668d52ba01e47718a6f818ee55a1dfbb83125a8b9dc6b7b206901826c93cf41b

# Copy our custom configuration file into the image
COPY config.yaml /app/config.yaml

# Set default host and port environment variables for LiteLLM
ENV PORT=4000
ENV HOST=0.0.0.0

# Expose the proxy port
EXPOSE 4000

# Start LiteLLM with our config, dynamically binding to the port Railway expects
CMD ["--config=/app/config.yaml", "--port=4000", "--host=0.0.0.0"]
