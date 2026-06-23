# -*- coding: utf-8 -*-
from fastapi import FastAPI, HTTPException, Request
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import pandas as pd
import numpy as np
import os
import sys
from datetime import datetime, timedelta
import uvicorn

# Add models directory to path
sys.path.append(os.path.join(os.path.dirname(__file__), 'models'))

from demand_forecasting_model import DemandForecastingModel

app = FastAPI(
    title="AI Demand Forecasting System", 
    description="Improving accuracy and reducing supply chain costs with machine learning",
    version="1.0.0"
)

# Static files and templates setup
import os
from pathlib import Path

# Set up directories
base_dir = Path(__file__).parent
static_dir = base_dir / "static" 
template_dir = base_dir / "templates"

# Mount static files BEFORE defining routes
try:
    # Try the most likely locations for static files
    if static_dir.exists():
        app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
        print(f"Static files mounted from: {static_dir}")
    elif Path("static").exists():
        app.mount("/static", StaticFiles(directory="static"), name="static")
        print("Static files mounted from: ./static")
    else:
        # Fallback - mount anyway and let it fail gracefully
        app.mount("/static", StaticFiles(directory="static"), name="static")
        print("Static files mounted with fallback")
except Exception as e:
    print(f"Could not mount static files: {e}")

# Set up templates
try:
    if template_dir.exists():
        templates = Jinja2Templates(directory=str(template_dir))
        print(f"Templates loaded from: {template_dir}")
    elif Path("templates").exists():
        templates = Jinja2Templates(directory="templates")
        print("Templates loaded from: ./templates")
    else:
        templates = Jinja2Templates(directory="templates")
        print("Templates loaded with fallback")
except Exception as e:
    print(f"Could not load templates: {e}")
    templates = None

# Global model instance
model = None
model_loaded = False

class PredictionRequest(BaseModel):
    item_id: str
    store_id: str
    dept_id: str
    sell_price: float
    prediction_date: str
    has_event: int = 0

class PredictionResponse(BaseModel):
    success: bool
    prediction: float = None
    error: str = None

def load_model():
    """Load the trained demand forecasting model"""
    global model, model_loaded
    
    try:
        model = DemandForecastingModel()
        model_path = os.path.join("models", "demand_forecasting_model.pkl")
        
        if os.path.exists(model_path):
            model.load_model(model_path)
            model_loaded = True
            print("Model loaded successfully!")
        else:
            print("No pre-trained model found. Please train the model first.")
            model_loaded = False
            
    except Exception as e:
        print(f"Error loading model: {e}")
        model_loaded = False

def get_data_stats():
    """Get basic statistics about the data"""
    try:
        # Load a sample of the sales data for stats
        sales_path = os.path.join("data", "sales_train_evaluation.csv")
        if os.path.exists(sales_path):
            print(f"Loading data stats from: {sales_path}")
            # Read just a sample for performance
            df_sample = pd.read_csv(sales_path, nrows=1000)
            
            # Format numbers with commas for better readability
            total_products = len(df_sample['item_id'].unique())
            total_stores = len(df_sample['store_id'].unique())
            
            stats = {
                'total_products': f"{total_products:,}" if total_products < 1000 else "3,049",  # Use known full dataset size
                'total_stores': f"{total_stores:,}" if total_stores > 1 else "10",  # Use known full dataset size
                'date_range': '1,913 days',  # Known from the data
                'avg_daily_sales': '2.5 units'  # Estimated
            }
            print(f"Data stats loaded: {stats}")
            return stats
        else:
            print(f"Data file not found at: {sales_path}")
    except Exception as e:
        print(f"Error getting data stats: {e}")
    
    # Return fallback stats if data file is not available
    print("Returning fallback data stats")
    return {
        'total_products': '3,049',
        'total_stores': '10',
        'date_range': '1,913 days',
        'avg_daily_sales': '2.5 units'
    }

@app.on_event("startup")
async def startup_event():
    """Load model on startup"""
    load_model()

@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    """Main dashboard page"""
    
    # Get model performance data if available
    model_scores = None
    best_model = None
    feature_importance = None
    
    if model_loaded and model:
        model_scores = getattr(model, 'model_scores', None)
        best_model = getattr(model, 'best_model_name', None)
        
        # Get feature importance
        try:
            feature_importance_df = model.get_feature_importance()
            if feature_importance_df is not None and not feature_importance_df.empty:
                # Keep the DataFrame but ensure it's not empty
                feature_importance = feature_importance_df.head(15)
                # Double-check it's not empty after head()
                if feature_importance.empty:
                    feature_importance = None
            else:
                feature_importance = None
        except Exception as e:
            print(f"Error getting feature importance: {e}")
            feature_importance = None
    
    # Get data statistics
    data_stats = get_data_stats()
    
    return templates.TemplateResponse(request, "index.html", {
        "model_scores": model_scores,
        "best_model": best_model,
        "feature_importance": feature_importance,
        "data_stats": data_stats
    })

@app.post("/api/predict", response_model=PredictionResponse)
async def predict_demand(request: PredictionRequest):
    """Make demand prediction"""
    
    if not model_loaded or not model:
        raise HTTPException(status_code=503, detail="Model not loaded. Please train the model first.")
    
    try:
        # Parse the prediction date
        pred_date = datetime.strptime(request.prediction_date, "%Y-%m-%d")
        
        # Extract date features
        day_of_week = pred_date.weekday()
        day_of_month = pred_date.day
        week_of_year = pred_date.isocalendar()[1]
        month = pred_date.month
        year = pred_date.year
        is_weekend = 1 if day_of_week >= 5 else 0
        
        # Create a mock prediction input (simplified for demo)
        # In a real scenario, you'd need more sophisticated feature engineering
        prediction_data = {
            'item_id': [request.item_id],
            'dept_id': [request.dept_id],
            'cat_id': [request.dept_id.split('_')[0]],  # Extract category from dept
            'store_id': [request.store_id],
            'state_id': [request.store_id.split('_')[0]],  # Extract state from store
            'wm_yr_wk': [year * 100 + week_of_year],  # Approximate week format
            'weekday': [day_of_week + 1],  # Convert to 1-7 format
            'month': [month],
            'year': [year],
            'day_of_week': [day_of_week],
            'day_of_month': [day_of_month],
            'week_of_year': [week_of_year],
            'is_weekend': [is_weekend],
            'sell_price': [request.sell_price],
            'price_change': [0],  # Default values for demo
            'price_change_pct': [0],
            'has_event': [request.has_event],
            'is_sporting_event': [0],
            'is_cultural_event': [0],
            'is_national_event': [0],
            'is_religious_event': [0],
            'total_snap': [1],  # Default assumption
            'snap_CA': [1 if 'CA' in request.store_id else 0],
            'snap_TX': [1 if 'TX' in request.store_id else 0],
            'snap_WI': [1 if 'WI' in request.store_id else 0],
        }
        
        # Add lag features with default values (for demo)
        for lag in [1, 7, 14, 28]:
            prediction_data[f'sales_lag_{lag}'] = [2.0]  # Default historical sales
        
        # Add rolling features with default values
        for window in [7, 14, 28]:
            prediction_data[f'sales_rolling_mean_{window}'] = [2.0]
            prediction_data[f'sales_rolling_std_{window}'] = [0.5]
        
        # Add price lag
        prediction_data['price_lag_1'] = [request.sell_price * 0.95]  # Slight variation
        
        # Create DataFrame
        df = pd.DataFrame(prediction_data)
        
        # Encode categorical variables using the model's label encoders
        categorical_cols = ['item_id', 'dept_id', 'cat_id', 'store_id', 'state_id']
        
        for col in categorical_cols:
            if col in model.label_encoders:
                try:
                    df[col] = model.label_encoders[col].transform(df[col])
                except ValueError:
                    # If the value is not in the encoder, use a default value
                    df[col] = 0
            else:
                df[col] = 0
        
        # Make prediction
        prediction = model.predict(df)[0]
        
        # Ensure prediction is non-negative
        prediction = max(0, float(prediction))
        
        return PredictionResponse(success=True, prediction=prediction)
        
    except Exception as e:
        print(f"Prediction error: {e}")
        return PredictionResponse(success=False, error=str(e))

@app.post("/api/train")
async def train_model():
    """Train the demand forecasting model"""
    global model, model_loaded
    
    try:
        # Check if data files exist
        data_dir = "data"
        required_files = ["sales_train_evaluation.csv", "calendar.csv", "sell_prices.csv"]
        
        for file in required_files:
            if not os.path.exists(os.path.join(data_dir, file)):
                raise HTTPException(status_code=404, detail=f"Data file {file} not found")
        
        # Initialize and train model
        model = DemandForecastingModel()
        
        sales_path = os.path.join(data_dir, "sales_train_evaluation.csv")
        calendar_path = os.path.join(data_dir, "calendar.csv")
        prices_path = os.path.join(data_dir, "sell_prices.csv")
        
        # Train model (this will take some time)
        scores = model.train(sales_path, calendar_path, prices_path)
        
        # Save the trained model
        model_path = os.path.join("models", "demand_forecasting_model.pkl")
        model.save_model(model_path)
        
        model_loaded = True
        
        return {
            "success": True,
            "message": "Model trained successfully!",
            "scores": scores,
            "best_model": model.best_model_name
        }
        
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

@app.get("/api/model/status")
async def model_status():
    """Get model status"""
    return {
        "loaded": model_loaded,
        "model_name": getattr(model, 'best_model_name', None) if model_loaded else None,
        "scores": getattr(model, 'model_scores', None) if model_loaded else None
    }

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "healthy", "model_loaded": model_loaded}

@app.get("/debug")
async def debug_info():
    """Debug endpoint to check file structure"""
    import os
    current_dir = os.getcwd()
    files = os.listdir(current_dir)
    
    debug_info = {
        "current_directory": current_dir,
        "files_in_directory": files,
        "static_exists": os.path.exists("static"),
        "templates_exists": os.path.exists("templates"),
        "model_exists": os.path.exists("demand_forecasting_model.pkl"),
        "models_dir_exists": os.path.exists("models")
    }
    
    if os.path.exists("static"):
        debug_info["static_files"] = os.listdir("static")
    if os.path.exists("templates"):  
        debug_info["template_files"] = os.listdir("templates")
        
    return debug_info

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 8000))
    
    print("Starting AI Demand Forecasting System...")
    print(f"Dashboard will be available at: http://0.0.0.0:{port}")
    print(f"API documentation at: http://0.0.0.0:{port}/docs")
    
    uvicorn.run(
        app, 
        host="0.0.0.0", 
        port=port,
        reload=False,  # Disable reload for production
        log_level="info"
    )