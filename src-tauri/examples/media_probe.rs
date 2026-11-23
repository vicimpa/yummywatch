//! Test-only stdio bridge: exercises the real backend without a TCP listener.
#![allow(dead_code)]
#[path = "../src/alloha.rs"]
mod alloha;
#[path = "../src/backend.rs"]
mod backend;
#[cfg(desktop)]
#[path = "../src/download_dash.rs"]
mod download_dash;
#[cfg(desktop)]
#[path = "../src/download_hls.rs"]
mod download_hls;
#[cfg(desktop)]
#[path = "../src/downloads.rs"]
mod downloads;
#[path = "../src/images.rs"]
mod images;
#[path = "../src/media.rs"]
mod media;
#[path = "../src/providers.rs"]
mod providers;
#[path = "../src/skips.rs"]
mod skips;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::io::BufRead;

#[tokio::main]
async fn main() {
    let backend = backend::Backend::new().unwrap();
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    while let Some(line) = receiver.recv().await {
        let backend = backend.clone();
        tokio::spawn(async move {
            let input: Value = serde_json::from_str(&line).unwrap();
            let result:Result<Value,String>=async {
                match input["action"].as_str().unwrap_or("") {
                    "resolve" => backend.resolve(serde_json::from_value(input["candidates"].clone()).map_err(|e|e.to_string())?).await,
                    "image"=>serde_json::to_value(images::fetch(&backend.client,input["url"].as_str().ok_or("Image URL missing")?).await?).map_err(|e|e.to_string()),
                    "media" => {
                        let mut request=tauri::http::Request::builder().uri(input["uri"].as_str().ok_or("URI missing")?).method(input["method"].as_str().unwrap_or("GET")).header("Origin","tauri://localhost");
                        if let Some(range)=input["range"].as_str(){request=request.header("Range",range);}
                        let response=backend.media(request.body(vec![]).map_err(|e|e.to_string())?).await;
                        let headers:std::collections::HashMap<_,_>=response.headers().iter().filter_map(|(k,v)|v.to_str().ok().map(|v|(k.as_str(),v))).collect();
                        Ok(json!({"status":response.status().as_u16(),"headers":headers,"body":STANDARD.encode(response.body())}))
                    }
                    _=>Err("Unknown probe action".into()),
                }
            }.await;
            println!(
                "{}",
                match result {
                    Ok(value) => json!({"id":input["id"],"result":value}),
                    Err(error) => json!({"id":input["id"],"error":error}),
                }
            );
        });
    }
}
