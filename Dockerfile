# Build stage
FROM golang:1.25-alpine AS builder

WORKDIR /app
COPY go.mod ./

RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux gop build -o reactor-server main.go

# Run stage
FROM alpine:latest

WORKDIR /app

COPY --from=builder /app/reactor-server .
COPY frontend/ ./frontend/

EXPOSE 80

CMD ["./reactor-server"]